import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { nodeCtas, rankCtas } from "../core/cta.ts";
import { score } from "../core/pipeline.ts";
import { buildModel, findingsImpact } from "../core/scoring.ts";
import { nodeHistory, recordFindings, saveSnapshot } from "../core/store.ts";
import { suggestTasks } from "../core/suggest.ts";
import { dbCache, type Db } from "../db.ts";
import { repoId } from "../paths.ts";
import { defaultPlugins } from "../plugins/index.ts";
import { llmScanPlugin, scanCoverage, scanNode } from "../plugins/llm-scan.ts";
import { TaskRunner } from "../runner/runner.ts";
import { HttpError, type Backend, type WorkerReport } from "../server/backend.ts";
import type {
  ApiNode,
  ApiOverview,
  ApiState,
  Cache,
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
} from "../types.ts";

/** Open pull requests and their babysit switch; the PR poller implements this. */
export interface PrSource {
  list(): PrState[];
  setBabysit(number: number, on: boolean): PrState | Promise<PrState>;
  /** Register a listener for PR changes; returns the unsubscribe function. */
  onChange(listener: (pr: PrState) => void): () => void;
}

export const noPrs: PrSource = {
  list: () => [],
  setBabysit: (number) => {
    throw new HttpError(404, `no PR #${number}`);
  },
  onChange: () => () => {},
};

export interface RepoBackendOptions {
  db: Db;
  repoRoot: string;
  cacheDir: string;
  config: Config;
  plugins?: MetricPlugin[];
  prs?: PrSource;
  log?: (msg: string) => void;
}

const OVERVIEW_SUGGESTIONS = 8;
const LIVE_STATES: Task["state"][] = ["queued", "running", "needs_input"];
const RESULT_KEY = ["backend", "result"] as const;

/** The real `Backend`: scorer, store, task runner, LLM scan and PR source. See docs/DESIGN.md "Backend". */
export class RepoBackend implements Backend {
  private readonly opts: Required<RepoBackendOptions>;
  private readonly cache: Cache;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly scanning = new Set<NodeId>();
  private readonly unsubscribePrs: () => void;
  private taskRunner?: TaskRunner;
  private result?: ScoreResult;
  private derived?: { result: ScoreResult; busyKey: string; suggestions: Suggestion[]; coverage?: ApiOverview["coverage"] };
  private scoring?: Promise<void>;
  private rescoreQueued = false;
  private scoreError?: string;

  constructor(opts: RepoBackendOptions) {
    this.opts = { plugins: [...defaultPlugins, llmScanPlugin], prs: noPrs, log: (msg) => console.error(msg), ...opts };
    this.cache = dbCache(opts.db);
    this.result = this.cache.get<ScoreResult>(...RESULT_KEY);
    this.unsubscribePrs = this.opts.prs.onChange((pr) => this.emit({ type: "pr", pr }));
  }

  /**
   * Start the task runner (workers report to `url` with `token`), recover tasks from a previous
   * server, and rescore when there is no stored result or HEAD moved.
   */
  attach(server: { url: string; token: string }): void {
    const { db, config, repoRoot, cacheDir } = this.opts;
    this.taskRunner = new TaskRunner({ db, config, repoRoot, cacheDir, ...server, onEvent: (e) => this.emit(e) });
    this.taskRunner.recover();
    if (!this.result || this.result.sha !== git(repoRoot, "rev-parse", "HEAD")) void this.rescore();
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

  close(): void {
    this.unsubscribePrs();
    this.taskRunner?.close();
  }

  async getState(): Promise<ApiState> {
    const result = await this.latest();
    const findingCounts: Record<NodeId, number> = {};
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
    if (!result.tree.nodes[id]) throw new HttpError(404, `no node ${JSON.stringify(id)}`);
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

  async taskDiff(taskId: string): Promise<string> {
    return this.runnerCall(() => this.runner().diff(taskId));
  }

  async startTask(req: StartTaskRequest): Promise<Task> {
    const result = await this.latest();
    if (!result.tree.nodes[req.node]) throw new HttpError(404, `no node ${JSON.stringify(req.node)}`);
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

  async cancel(taskId: string): Promise<Task> {
    return this.runnerCall(() => this.runner().cancel(taskId));
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
    if (!result.tree.nodes[node]) throw new HttpError(404, `no node ${JSON.stringify(node)}`);
    if (this.scanning.has(node)) throw new HttpError(409, `node ${JSON.stringify(node)} is already being scanned`);
    this.scanning.add(node);
    this.emit({ type: "scan", node, status: "running" });
    scanNode(node, this.collectCtx(result), {
      onProgress: (p) => this.emit({ type: "scan", node, status: "running", message: `${p.done}/${p.total} batches` }),
    })
      .then((p) => {
        const failed = p.failed ? `, ${p.failed} failed` : "";
        this.emit({ type: "scan", node, status: "done", message: `${p.findings} findings in ${p.total} batches${failed}` });
        return this.rescore();
      })
      .catch((err: unknown) => this.emit({ type: "scan", node, status: "failed", message: errorText(err) }))
      .finally(() => this.scanning.delete(node));
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
      const base = git(this.opts.repoRoot, "rev-parse", this.opts.config.baseRef);
      for (const worktree of worktrees) for (const file of git(worktree, "diff", "--name-only", base).split("\n")) if (file) paths.add(file);
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

/** Trimmed stdout of a git command, or "" when it fails (e.g. a worktree that was removed). */
function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
