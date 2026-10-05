import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { interleave, nodeCtas, rankCtas } from "../core/cta.ts";
import { ALL_PROJECTS, QUALITY, createProject, deleteProjectRows, getProject, hasScorer, listProjects, saveProject } from "../core/projects.ts";
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
import { PrPoller, prRetired } from "../prs/poller.ts";
import { TaskRunner } from "../runner/runner.ts";
import { HttpError, type Backend, type ProjectInput, type WorkerReport } from "../server/backend.ts";
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
  MetricValues,
  NodeId,
  NodeScore,
  PrState,
  Project,
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
const NO_COVERAGE: ApiOverview["coverage"] = { scannedNodes: 0, totalNodes: 0, scannedLoc: 0, totalLoc: 0 };
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
  private derived?: { result: ScoreResult; busyKey: string; suggestions: Suggestion[] };
  private scanned?: { result: ScoreResult; coverage: ApiOverview["coverage"] };
  private unscoredView?: { from: ScoreResult; result: ScoreResult };
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

  async listProjects(): Promise<Project[]> {
    return listProjects(this.opts.db);
  }

  async createProject({ name, goal }: ProjectInput): Promise<Project> {
    if (!name?.trim()) throw new HttpError(400, "name must not be empty");
    return createProject(this.opts.db, name.trim(), goal?.trim() || undefined);
  }

  async updateProject(id: string, { name, goal }: ProjectInput): Promise<Project> {
    const { goal: oldGoal, ...project } = this.project(id);
    if (name !== undefined && !name.trim()) throw new HttpError(400, "name must not be empty");
    const nextGoal = goal === undefined ? oldGoal : goal.trim();
    const updated: Project = { ...project, ...(name !== undefined && { name: name.trim() }), ...(nextGoal && { goal: nextGoal }) };
    saveProject(this.opts.db, updated);
    return updated;
  }

  async deleteProject(id: string): Promise<void> {
    const project = this.project(id);
    if (project.builtin) throw new HttpError(409, `${project.name} is built in`);
    const tasks = this.runner().list().filter((t) => t.project === id);
    const prClosed = (t: Task) => t.pr !== undefined && prRetired(this.cache, t.pr);
    const blocking = tasks.find((t) => LIVE_STATES.includes(t.state) || (t.state === "pr_open" && !prClosed(t)));
    if (blocking) throw new HttpError(409, `task ${blocking.id} is ${blocking.state}; cancel it or close its PR first`);
    for (const task of tasks) this.runnerCall(() => this.runner().discard(task.id, { prClosed: prClosed(task) }));
    deleteProjectRows(this.opts.db, id);
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

  async getState(projectId?: string): Promise<ApiState> {
    const { project, result } = await this.view(projectId);
    const findingCounts = dict<number>();
    for (const f of result.findings) findingCounts[f.node] = (findingCounts[f.node] ?? 0) + 1;
    const { repoRoot, config } = this.opts;
    return {
      repo: { root: repoRoot, id: repoId(repoRoot), name: basename(repoRoot) },
      project,
      snapshot: { sha: result.sha, createdAt: result.createdAt },
      tree: result.tree,
      metricDefs: result.metricDefs,
      weights: config.weights,
      scores: result.scores,
      tasks: this.tasks(project.id),
      prs: this.prs(project.id),
      findingCounts,
    };
  }

  async getNode(id: NodeId, projectId?: string): Promise<ApiNode> {
    const { project, result } = await this.view(projectId);
    if (!hasNode(result, id)) throw new HttpError(404, `no node ${JSON.stringify(id)}`);
    const tasks = this.tasks(project.id);
    const prs = this.prs(project.id);
    const suggestions = this.suggestions(project, result);
    return {
      score: result.scores[id],
      history: nodeHistory(this.opts.db, id, project.id),
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

  async getOverview(projectId?: string): Promise<ApiOverview> {
    const all = projectId === ALL_PROJECTS;
    const { project, result } = await this.view(all ? QUALITY : projectId);
    const scope = all ? undefined : project.id;
    const suggestions = all
      ? interleave(listProjects(this.opts.db).map((p) => this.suggestions(p, result).map((s) => ({ ...s, project: p.id }))))
      : this.suggestions(project, result);
    return {
      attentionTasks: this.tasks(scope).filter((t) => t.state === "needs_input" || t.state === "review"),
      flaggedPrs: this.prs(scope).filter((p) => p.ci === "fail" || p.stuck || p.stale),
      suggestions: suggestions.slice(0, OVERVIEW_SUGGESTIONS),
      coverage: hasScorer(project) ? this.coverage(result) : NO_COVERAGE,
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
    const { project, result } = await this.view(req.project);
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
      project: project.id,
      ...(project.goal && { brief: `Project: ${project.name}\nGoal: ${project.goal}` }),
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
  async rescore(projectId?: string): Promise<void> {
    this.project(projectId);
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

  async scan(node: NodeId, projectId?: string): Promise<void> {
    const project = this.project(projectId);
    if (!hasScorer(project)) throw new HttpError(400, `${project.name} has no scorer to scan with`);
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

  private project(id = QUALITY): Project {
    const project = getProject(this.opts.db, id);
    if (!project) throw new HttpError(404, `no project ${JSON.stringify(id)}`);
    return project;
  }

  /** The project and its scores: the latest result, or for a project without a scorer the shared tree with neutral metrics only. */
  private async view(projectId?: string): Promise<{ project: Project; result: ScoreResult }> {
    const project = this.project(projectId);
    const result = await this.latest();
    if (hasScorer(project)) return { project, result };
    if (this.unscoredView?.from !== result) this.unscoredView = { from: result, result: unscored(result) };
    return { project, result: this.unscoredView.result };
  }

  /** Tasks of `project`, or of every project. */
  private tasks(project?: string): Task[] {
    const tasks = this.runner().list();
    return project === undefined ? tasks : tasks.filter((t) => t.project === project);
  }

  /** Open PRs labelled with their project (their task's, else Quality), of `project` or every project. */
  private prs(project?: string): PrState[] {
    const prs = this.opts.prs.list().map((pr) => this.withProject(pr));
    return project === undefined ? prs : prs.filter((pr) => pr.project === project);
  }

  private withProject(pr: PrState): PrState {
    return { ...pr, project: (pr.taskId && this.taskRunner?.get(pr.taskId)?.project) || QUALITY };
  }

  private coverage(result: ScoreResult): ApiOverview["coverage"] {
    if (this.scanned?.result !== result) this.scanned = { result, coverage: scanCoverage(this.collectCtx(result)) };
    return this.scanned.coverage;
  }

  /** Suggestions of a scored project for `result`, recomputed when the result or the busy paths change. */
  private suggestions(project: Project, result: ScoreResult): Suggestion[] {
    if (!hasScorer(project)) return [];
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
    if (event.type === "pr") event = { ...event, pr: this.withProject(event.pr) };
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

/** `result` without scores or findings: the shared tree keeps its neutral metrics (sizes), every node is unscored. */
function unscored(result: ScoreResult): ScoreResult {
  const neutral = new Set(result.metricDefs.filter((d) => d.direction === "neutral").map((d) => d.key));
  const keep = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([key]) => neutral.has(key)));
  return {
    ...result,
    metricDefs: result.metricDefs.filter((d) => neutral.has(d.key)),
    own: Object.assign(dict<MetricValues[NodeId]>(), Object.fromEntries(Object.entries(result.own).map(([node, values]) => [node, keep(values)]))),
    scores: Object.assign(
      dict<NodeScore>(),
      Object.fromEntries(Object.entries(result.scores).map(([node, s]) => [node, { node, quality: null, metrics: keep(s.metrics) }])),
    ),
    findings: [],
    impacts: {},
  };
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
