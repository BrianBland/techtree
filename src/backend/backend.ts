import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { nodeCtas, rankCtas } from "../core/cta.ts";
import { score } from "../core/pipeline.ts";
import { dict } from "../core/tree.ts";
import { buildModel, findingsImpact } from "../core/scoring.ts";
import { nodeHistory, recordFindings, saveSnapshot } from "../core/store.ts";
import { suggestTasks } from "../core/suggest.ts";
import { dbCache, type Db } from "../db.ts";
import { repoId } from "../paths.ts";
import { defaultPlugins } from "../plugins/index.ts";
import { llmScanPlugin, scanCoverage, scanNode } from "../plugins/llm-scan.ts";
import { listModels } from "./models.ts";
import { launchDetached, shellQuote, terminalArgv } from "./terminal.ts";
import { Babysitter } from "../prs/babysit.ts";
import { PrPoller } from "../prs/poller.ts";
import { TaskRunner } from "../runner/runner.ts";
import { HttpError, type Backend, type WorkerReport } from "../server/backend.ts";
import type {
  ApiModels,
  ApiNode,
  ApiOverview,
  ApiSource,
  ApiState,
  Cache,
  ChatEntry,
  CollectCtx,
  Config,
  Finding,
  MetricPlugin,
  NodeId,
  PrState,
  ScoreResult,
  ServerEvent,
  StartTaskRequest,
  Suggestion,
  Task,
  TerminalMode,
} from "../types.ts";

/** Open pull requests and their babysit switch; the PR poller implements this. */
export interface PrSource {
  list(): PrState[];
  setBabysit(number: number, on: boolean): PrState | Promise<PrState>;
  /** Register a listener for `pr` / `pr_removed` events; returns the unsubscribe function. */
  onEvent(listener: (event: ServerEvent) => void): () => void;
}

export const noPrs: PrSource = {
  list: () => [],
  setBabysit: (number) => {
    throw new HttpError(404, `no PR #${number}`);
  },
  onEvent: () => () => {},
};

export interface RepoBackendOptions {
  db: Db;
  repoRoot: string;
  cacheDir: string;
  config: Config;
  plugins?: MetricPlugin[];
  prs?: PrSource;
  /** Poll GitHub for PRs with `gh` and babysit them once attached (ignored when `prs` is given). */
  pollPrs?: boolean;
  log?: (msg: string) => void;
}

const OVERVIEW_SUGGESTIONS = 8;
const LIVE_STATES: Task["state"][] = ["queued", "running", "needs_input"];
const RESULT_KEY = ["backend", "result"] as const;
const MODELS_TTL_MS = 10 * 60_000;

/** The real `Backend`: scorer, store, task runner, LLM scan and PR source. See docs/DESIGN.md "Backend". */
export class RepoBackend implements Backend {
  private readonly opts: Required<RepoBackendOptions>;
  private readonly cache: Cache;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  /** Scans in progress by node; settled once their pi children have exited. */
  private readonly scanning = new Map<NodeId, Promise<void>>();
  private readonly stopScans = new AbortController();
  private readonly unsubscribePrs: () => void;
  private taskRunner?: TaskRunner;
  private result?: ScoreResult;
  private stopPrPolling?: () => void;
  private derived?: { result: ScoreResult; busyKey: string; suggestions: Suggestion[]; coverage?: ApiOverview["coverage"] };
  private scoring?: Promise<void>;
  private rescoreQueued = false;
  private scoreError?: string;
  private modelList?: { at: number; models: Promise<string[]> };

  constructor(opts: RepoBackendOptions) {
    this.opts = { plugins: [...defaultPlugins, llmScanPlugin], prs: noPrs, pollPrs: false, log: (msg) => console.error(msg), ...opts };
    this.cache = dbCache(opts.db);
    this.result = this.cache.get<ScoreResult>(...RESULT_KEY);
    this.unsubscribePrs = this.opts.prs.onEvent((event) => this.emit(event));
  }

  /**
   * Start the task runner (workers report to `url` with `token`), recover tasks from a previous
   * server, and rescore when there is no stored result or HEAD moved.
   */
  attach(server: { url: string; token: string }): void {
    const { db, config, repoRoot, cacheDir } = this.opts;
    this.taskRunner = new TaskRunner({ db, config, repoRoot, cacheDir, ...server, onEvent: (e) => this.emit(e) });
    this.taskRunner.recover();
    if (this.opts.pollPrs && this.opts.prs === noPrs) this.startPrPolling(this.taskRunner);
    if (!this.result || this.result.sha !== git(repoRoot, "rev-parse", "HEAD").trim()) void this.rescore();
  }

  private startPrPolling(runner: TaskRunner): void {
    const poller: PrPoller = new PrPoller({
      db: this.opts.db,
      repoRoot: this.opts.repoRoot,
      tree: () => this.result?.tree,
      tasks: () => runner.list(),
      onEvent: (event) => this.emit(event),
      onUpdate: (prev, next) => babysitter.onUpdate(prev, next),
      onRemove: (pr) => babysitter.onRemove(pr),
    });
    const babysitter = new Babysitter({ poller, runner });
    this.opts.prs = { list: () => poller.list(), setBabysit: (n, on) => babysitter.setBabysit(n, on), onEvent: () => () => {} };
    this.stopPrPolling = () => poller.stop();
    poller.start();
  }

  /** Whether anything should keep the server alive: SSE clients, live or queued tasks, scoring or scans. */
  busy(): boolean {
    return (
      this.listeners.size > 0 ||
      this.scoring !== undefined ||
      this.scanning.size > 0 ||
      this.runner().list().some((t) => LIVE_STATES.includes(t.state))
    );
  }

  /** Resolves once the scoring run in progress (if any) has finished. */
  async idle(): Promise<void> {
    while (this.scoring) await this.scoring;
  }

  /** Detach from task workers and stop running scans, resolving once their children have exited. */
  async close(): Promise<void> {
    this.unsubscribePrs();
    this.stopPrPolling?.();
    this.taskRunner?.close();
    this.stopScans.abort(new Error("techtree server stopped"));
    await Promise.all(this.scanning.values());
  }

  async getState(): Promise<ApiState> {
    const result = await this.latest();
    const findingCounts = dict<number>();
    for (const f of result.findings) findingCounts[f.node] = (findingCounts[f.node] ?? 0) + 1;
    const { repoRoot, config } = this.opts;
    return {
      repo: { root: repoRoot, id: repoId(repoRoot), name: basename(repoRoot) },
      snapshot: { sha: result.sha, createdAt: result.createdAt },
      tree: result.tree,
      metricDefs: result.metricDefs,
      weights: config.weights,
      scores: result.scores,
      tasks: this.runner().list(),
      prs: this.opts.prs.list(),
      findingCounts,
    };
  }

  async getNode(id: NodeId): Promise<ApiNode> {
    const result = await this.latest();
    if (!hasNode(result, id)) throw new HttpError(404, `no node ${JSON.stringify(id)}`);
    const tasks = this.runner().list();
    const prs = this.opts.prs.list();
    const suggestions = this.suggestions(result);
    return {
      score: result.scores[id],
      history: nodeHistory(this.opts.db, id),
      findings: result.findings
        .filter((f) => f.node === id)
        .map((f) => ({ ...f, impact: result.impacts[f.id] }))
        .sort((a, b) => b.impact.node - a.impact.node),
      prs: prs.filter((p) => p.node === id),
      tasks: tasks.filter((t) => t.node === id),
      suggestions: suggestions.filter((s) => s.node === id),
      ...nodeCtas(id, rankCtas(tasks, prs, suggestions)),
    };
  }

  async getOverview(): Promise<ApiOverview> {
    const result = await this.latest();
    const suggestions = this.suggestions(result);
    const derived = this.derived!;
    derived.coverage ??= scanCoverage(this.collectCtx(result));
    return {
      attentionTasks: this.runner().list().filter((t) => t.state === "needs_input" || t.state === "review"),
      flaggedPrs: this.opts.prs.list().filter((p) => p.ci === "fail" || p.stuck || p.stale),
      suggestions: suggestions.slice(0, OVERVIEW_SUGGESTIONS),
      coverage: derived.coverage,
    };
  }

  async taskLog(taskId: string, tail: number): Promise<string> {
    const task = this.task(taskId);
    let text: string;
    try {
      text = readFileSync(task.logPath!, "utf8");
    } catch {
      return "";
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return tail === 0 ? "" : lines.slice(-tail).join("\n");
  }

  async source(path: string, line?: number): Promise<ApiSource> {
    const { sha } = await this.latest();
    if (!path || path.startsWith("-") || path.startsWith("/") || path.split("/").includes("..")) throw new HttpError(400, "bad path");
    let text: string;
    try {
      ({ stdout: text } = await promisify(execFile)("git", ["show", `${sha}:${path}`], { cwd: this.opts.repoRoot, maxBuffer: 8 * 1024 * 1024 }));
    } catch {
      throw new HttpError(404, `no file ${JSON.stringify(path)} at ${sha.slice(0, 8)}`);
    }
    const all = text.split("\n");
    const start = line ? Math.max(1, line - 10) : 1;
    const end = line ? line + 20 : 30;
    return { path, startLine: start, lines: all.slice(start - 1, end).map((l) => l.slice(0, 400)) };
  }

  async taskDiff(taskId: string): Promise<string> {
    return this.runnerCall(() => this.runner().diff(taskId));
  }

  /** pi's models (cached; a failed or empty listing is retried next time) and the start-dialog default. */
  async models(): Promise<ApiModels> {
    const { config } = this.opts;
    const lastUsed = this.runner().list().findLast((t) => t.model)?.model;
    if (!this.modelList || Date.now() - this.modelList.at > MODELS_TTL_MS) {
      const entry = { at: Date.now(), models: listModels(config.piCommand) };
      this.modelList = entry;
      void entry.models.then((models) => {
        if (!models.length && this.modelList === entry) this.modelList = undefined;
      });
    }
    return { default: config.defaultModel || lastUsed || null, models: await this.modelList.models };
  }

  async startTask(req: StartTaskRequest): Promise<Task> {
    const result = await this.latest();
    if (!hasNode(result, req.node)) throw new HttpError(404, `no node ${JSON.stringify(req.node)}`);
    const byId = new Map(result.findings.map((f) => [f.id, f]));
    const unknown = req.findingIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new HttpError(400, `unknown findings: ${unknown.join(", ")}`);
    const findings = req.findingIds.map((id) => byId.get(id)!);
    const plannedFrom = result.scores[req.node]?.quality ?? 0;
    const model = buildModel(result.tree, result.metricDefs, result.own, this.opts.config);
    const gain = findings.length ? findingsImpact(model, findings, req.node).node : 0;
    return this.runner().start({
      ...req,
      title: req.title ?? (findings.length === 1 ? findings[0].title : undefined),
      prompt: req.prompt ?? (findings.length ? findingsPrompt(req.node, findings) : undefined),
      plannedFrom,
      plannedTo: plannedFrom + gain,
    });
  }

  async answer(taskId: string, text: string): Promise<Task> {
    return this.runnerCall(() => this.runner().answer(taskId, text));
  }

  async openPr(taskId: string): Promise<Task> {
    return this.runnerCall(() => this.runner().openPr(taskId));
  }

  async discard(taskId: string): Promise<void> {
    return this.runnerCall(() => this.runner().discard(taskId));
  }

  async cancel(taskId: string): Promise<Task> {
    return this.runnerCall(() => this.runner().cancel(taskId));
  }

  async message(taskId: string, text: string): Promise<Task> {
    return this.runnerCall(() => this.runner().message(taskId, text));
  }

  async chat(taskId: string): Promise<ChatEntry[]> {
    return this.runnerCall(() => this.runner().chat(taskId));
  }

  async openTerminal(taskId: string, mode: TerminalMode): Promise<void> {
    const task = this.task(taskId);
    if (!task.worktree || !existsSync(task.worktree)) throw new HttpError(409, `task ${taskId} has no worktree`);
    const command = mode === "agent" ? shellQuote(this.runnerCall(() => this.runner().agentCommand(taskId))) : "";
    const argv = terminalArgv({ template: this.opts.config.terminal, platform: process.platform, cwd: task.worktree, command });
    if (!argv) throw new HttpError(501, `no default terminal on ${process.platform}; set "terminal" in .techtree.yaml`);
    await launchDetached(argv);
  }

  async report(taskId: string, report: WorkerReport): Promise<Task> {
    return this.runnerCall(() => this.runner().report(taskId, report));
  }

  async setBabysit(prNumber: number, on: boolean): Promise<PrState> {
    return this.opts.prs.setBabysit(prNumber, on);
  }

  /** Start a scoring run (or queue one behind the run in progress); completion is a `scores` event. */
  async rescore(): Promise<void> {
    if (this.scoring) {
      this.rescoreQueued = true;
      return;
    }
    this.scoring = this.runScoring().finally(() => {
      this.scoring = undefined;
      if (this.rescoreQueued) {
        this.rescoreQueued = false;
        void this.rescore();
      }
    });
  }

  async scan(node: NodeId): Promise<void> {
    const result = await this.latest();
    if (!hasNode(result, node)) throw new HttpError(404, `no node ${JSON.stringify(node)}`);
    if (this.scanning.has(node)) throw new HttpError(409, `node ${JSON.stringify(node)} is already being scanned`);
    this.emit({ type: "scan", node, status: "running" });
    const run = scanNode(node, this.collectCtx(result), {
      signal: this.stopScans.signal,
      onProgress: (p) => this.emit({ type: "scan", node, status: "running", message: `${p.done}/${p.total} batches` }),
    })
      .then((p) => {
        const failed = p.failed ? `, ${p.failed} failed` : "";
        this.emit({ type: "scan", node, status: "done", message: `${p.findings} findings in ${p.total} batches${failed}` });
        return this.rescore();
      })
      .catch((err: unknown) => this.emit({ type: "scan", node, status: "failed", message: errorText(err) }))
      .finally(() => this.scanning.delete(node));
    this.scanning.set(node, run);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runScoring(): Promise<void> {
    const { db, repoRoot, config, plugins, log } = this.opts;
    try {
      const result = await score({ repoRoot, config, plugins, cache: this.cache, log });
      saveSnapshot(db, result);
      recordFindings(db, result.findings, result.createdAt, true);
      this.cache.set(...RESULT_KEY, result);
      this.result = result;
      this.scoreError = undefined;
      this.emit({ type: "scores", snapshot: { sha: result.sha, createdAt: result.createdAt } });
    } catch (err) {
      this.scoreError = errorText(err);
      log(`scoring failed: ${this.scoreError}`);
    }
  }

  /** The latest result, waiting for a run in progress when there is none yet. */
  private async latest(): Promise<ScoreResult> {
    while (!this.result) {
      if (!this.scoring) throw new HttpError(503, `not scored yet${this.scoreError ? `: ${this.scoreError}` : ""}`);
      await this.scoring;
    }
    return this.result;
  }

  /** Suggestions for `result`, recomputed when the result or the busy paths change. */
  private suggestions(result: ScoreResult): Suggestion[] {
    const busy = this.busyPaths();
    const busyKey = busy.join("\0");
    if (this.derived?.result !== result) this.derived = { result, busyKey, suggestions: suggestTasks(result, this.opts.config, busy) };
    else if (this.derived.busyKey !== busyKey) Object.assign(this.derived, { busyKey, suggestions: suggestTasks(result, this.opts.config, busy) });
    return this.derived.suggestions;
  }

  private busyPaths(): string[] {
    const paths = new Set<string>();
    const worktrees = this.runner()
      .list()
      .flatMap((t) => (t.worktree && LIVE_STATES.includes(t.state) ? [t.worktree] : []));
    if (worktrees.length) {
      const base = git(this.opts.repoRoot, "rev-parse", this.opts.config.baseRef).trim();
      for (const worktree of worktrees) for (const file of git(worktree, "diff", "--name-only", "-z", base).split("\0")) if (file) paths.add(file);
    }
    for (const pr of this.opts.prs.list()) for (const file of pr.files) paths.add(file);
    return [...paths].sort();
  }

  private collectCtx(result: ScoreResult): CollectCtx {
    const { repoRoot, config, log } = this.opts;
    return { repoRoot, tree: result.tree, config, cache: this.cache, log };
  }

  private runner(): TaskRunner {
    if (!this.taskRunner) throw new HttpError(503, "backend not attached");
    return this.taskRunner;
  }

  private task(taskId: string): Task {
    const task = this.runner().get(taskId);
    if (!task) throw new HttpError(404, `unknown task ${taskId}`);
    return task;
  }

  private runnerCall<T>(call: () => T): T {
    try {
      return call();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = errorText(err);
      const status = /^unknown task/.test(message) ? 404 : /^(no checklist item|unknown phase|plan must)/.test(message) ? 400 : 409;
      throw new HttpError(status, message);
    }
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function findingsPrompt(node: NodeId, findings: Finding[]): string {
  const where = node ? `\`${node}\`` : "the repository root";
  const items = findings.map((f) => {
    const location = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : "";
    return `- ${location}${f.title} (${f.source}, ${f.severity} severity)\n  ${f.detail.replaceAll("\n", "\n  ")}`;
  });
  return `Fix these techtree findings in ${where}:\n${items.join("\n")}`;
}

/** Own-property check: a restored result's plain objects would otherwise "contain" ids like "toString". */
function hasNode(result: ScoreResult, id: NodeId): boolean {
  return Object.hasOwn(result.tree.nodes, id);
}

/** Stdout of a git command, or "" when it fails (e.g. a worktree that was removed). */
function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
