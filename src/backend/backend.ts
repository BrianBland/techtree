import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { interleave, nodeCtas, rankCtas } from "../core/cta.ts";
import {
  ALL_PROJECTS,
  QUALITY,
  createProject,
  deleteProjectRows,
  getProject,
  hasScorer,
  isScannable,
  isScored,
  listProjects,
  saveProject,
} from "../core/projects.ts";
import { score } from "../core/pipeline.ts";
import { dict } from "../core/tree.ts";
import { buildModel, findingImpact, findingsImpact } from "../core/scoring.ts";
import { nodeHistory, recordFindings, saveSnapshot } from "../core/store.ts";
import { suggestTasks } from "../core/suggest.ts";
import { dbCache, type Db } from "../db.ts";
import { repoId } from "../paths.ts";
import { defaultPlugins } from "../plugins/index.ts";
import { commandPlugin } from "../plugins/command.ts";
import { QUALITY_SCAN, llmScanPlugin, rubricScan, scanCoverage, scanNode, scanPlugin, type ScanKind } from "../plugins/llm-scan.ts";
import { addPlanItems, parsePlanItems, planPlugin, type PlanItem } from "../plugins/plan.ts";
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
  ScorerSpec,
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

/** A custom project's latest scoring run (DESIGN "Project scorers"). */
interface ProjectRun {
  result: ScoreResult;
  /** `config.weights` plus weight 1 for the project's other non-neutral metrics. */
  weights: Record<string, number>;
  errors: string[];
}

/** What a project's views are computed from. */
interface View {
  project: Project;
  result: ScoreResult;
  config: Config;
  errors: string[];
}

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
  private readonly derived = new Map<string, { result: ScoreResult; busyKey: string; suggestions: Suggestion[] }>();
  private readonly scanned = new WeakMap<ScoreResult, ApiOverview["coverage"]>();
  private readonly projectRuns = new Map<string, ProjectRun>();
  /** Change tasks of plan projects whose finish already triggered a rescore. */
  private readonly resolvedPlanTasks = new Set<string>();
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

  async updateProject(id: string, { name, goal, scorer }: ProjectInput): Promise<Project> {
    const { goal: oldGoal, ...project } = this.project(id);
    if (name !== undefined && !name.trim()) throw new HttpError(400, "name must not be empty");
    if (scorer && project.builtin) throw new HttpError(400, `${project.name}'s scorer is built in`);
    const nextGoal = goal === undefined ? oldGoal : goal.trim();
    const updated: Project = {
      ...project,
      ...(name !== undefined && { name: name.trim() }),
      ...(nextGoal && { goal: nextGoal }),
      ...(scorer && { scorer: withParts(project.scorer, scorer) }),
    };
    saveProject(this.opts.db, updated);
    if (scorer) void this.rescore();
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
    this.opts.db.prepare("DELETE FROM cache WHERE (kind = 'backend' AND key = ?) OR (kind = 'plan' AND key = ?)").run(`result:${id}`, id);
    this.projectRuns.delete(id);
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
    return this.listeners.size > 0 || this.analyzing() || this.runner().list().some((t) => LIVE_STATES.includes(t.state));
  }

  /** Whether a scoring run or LLM scan is in progress (work a restart would lose, unlike tasks, which resume). */
  analyzing(): boolean {
    return this.scoring !== undefined || this.scanning.size > 0;
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
    const { project, result, config } = await this.view(projectId);
    const findingCounts = dict<number>();
    for (const f of result.findings) findingCounts[f.node] = (findingCounts[f.node] ?? 0) + 1;
    const { repoRoot } = this.opts;
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
    const view = await this.view(projectId);
    const { project, result } = view;
    if (!hasNode(result, id)) throw new HttpError(404, `no node ${JSON.stringify(id)}`);
    const tasks = this.tasks(project.id);
    const prs = this.prs(project.id);
    const suggestions = this.suggestions(view);
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
    const view = await this.view(all ? QUALITY : projectId);
    const scope = all ? undefined : view.project.id;
    const suggestions = all
      ? interleave(
          await Promise.all(
            listProjects(this.opts.db).map(async (p) => this.suggestions(await this.view(p.id)).map((s) => ({ ...s, project: p.id }))),
          ),
        )
      : this.suggestions(view);
    return {
      attentionTasks: this.tasks(scope).filter((t) => t.state === "needs_input" || t.state === "review"),
      flaggedPrs: this.prs(scope).filter((p) => p.ci === "fail" || p.stuck || p.stale),
      suggestions: suggestions.slice(0, OVERVIEW_SUGGESTIONS),
      coverage: this.coverage(view),
      ...(!all && view.errors.length && { scorerErrors: view.errors }),
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
    const view = await this.view(req.project);
    if (req.kind === "scorer" || req.kind === "plan") return this.startProjectTask(view, req);
    const { project, result } = view;
    if (!hasNode(result, req.node)) throw new HttpError(404, `no node ${JSON.stringify(req.node)}`);
    const byId = new Map(result.findings.map((f) => [f.id, f]));
    const unknown = req.findingIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new HttpError(400, `unknown findings: ${unknown.join(", ")}`);
    const findings = req.findingIds.map((id) => byId.get(id)!);
    const plannedFrom = result.scores[req.node]?.quality ?? 0;
    const model = buildModel(result.tree, result.metricDefs, result.own, view.config);
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

  /** A scorer or plan task (DESIGN "Task kinds"), anchored at the root with a prompt built from the project. */
  private startProjectTask({ project, result, config }: View, req: StartTaskRequest): Task {
    if (project.builtin) throw new HttpError(400, `${project.name}'s scorer is built in`);
    const instruction = req.prompt?.trim() ? `\n\nInstruction from the user: ${req.prompt.trim()}` : "";
    const quality = result.scores[""]?.quality ?? 0;
    let title: string;
    let prompt: string;
    if (req.kind === "plan") {
      if (!project.scorer.plan) saveProject(this.opts.db, { ...project, scorer: { ...project.scorer, plan: true } });
      title = "Plan the work";
      prompt = planPrompt() + instruction;
    } else {
      const scriptsDir = join(this.opts.cacheDir, "projects", project.id);
      mkdirSync(scriptsDir, { recursive: true });
      title = isScored(project) ? "Refine scorer" : "Draft scorer";
      prompt = scorerPrompt(project, result, config, scriptsDir) + instruction;
    }
    return this.runner().start({
      node: "",
      findingIds: [],
      manualReview: false,
      ...(req.model && { model: req.model }),
      kind: req.kind,
      title,
      prompt,
      project: project.id,
      ...(project.goal && { brief: `Project: ${project.name}\nGoal: ${project.goal}` }),
      plannedFrom: quality,
      plannedTo: quality,
    });
  }

  async acceptScorer(taskId: string): Promise<Task> {
    const task = this.runnerCall(() => this.runner().acceptProposal(taskId));
    const project = this.project(task.project);
    saveProject(this.opts.db, { ...project, scorer: withParts(project.scorer, task.proposal!) });
    void this.rescore();
    return task;
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
    const task = this.task(taskId);
    let items: PlanItem[] | undefined;
    if (report.items !== undefined) {
      const result = await this.latest();
      const parsed = parsePlanItems(report.items, task.project, (id) => hasNode(result, id));
      if (typeof parsed === "string") throw new HttpError(400, parsed);
      items = parsed;
    }
    const updated = this.runnerCall(() => this.runner().report(taskId, report));
    if (items) {
      addPlanItems(this.cache, task.project, items);
      void this.rescore();
    }
    return updated;
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
    if (!isScannable(project)) throw new HttpError(400, `${project.name} has no rubric to scan with`);
    const result = await this.latest();
    if (!hasNode(result, node)) throw new HttpError(404, `no node ${JSON.stringify(node)}`);
    if (this.scanning.has(node)) throw new HttpError(409, `node ${JSON.stringify(node)} is already being scanned`);
    this.emit({ type: "scan", node, status: "running" });
    const run = scanNode(node, this.collectCtx(result), {
      scan: scanKind(project),
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
      for (const project of listProjects(db)) if (!hasScorer(project) && isScored(project)) await this.scoreProject(project, result);
      this.emit({ type: "scores", snapshot: { sha: result.sha, createdAt: result.createdAt } });
    } catch (err) {
      this.scoreError = errorText(err);
      log(`scoring failed: ${this.scoreError}`);
    }
  }

  /** Score a custom project over `base`'s tree with its scorer's parts; failures are kept as its `errors`. */
  private async scoreProject(project: Project, base: ScoreResult): Promise<void> {
    const { db, repoRoot, config, log } = this.opts;
    const errors: string[] = [];
    const onLog = (msg: string) => {
      log(`${project.id}: ${msg}`);
      if (msg.includes(": collect failed: ")) errors.push(msg);
    };
    try {
      const raw = await score({ repoRoot, config, plugins: this.projectPlugins(project, base), cache: this.cache, log: onLog, tree: base.tree });
      const weights = projectWeights(raw, config);
      const model = buildModel(raw.tree, raw.metricDefs, raw.own, { ...config, weights });
      const impacts = Object.fromEntries(raw.findings.map((f) => [f.id, findingImpact(model, f)]));
      const result: ScoreResult = { ...raw, sha: base.sha, scores: model.scores, impacts };
      saveSnapshot(db, result, project.id);
      recordFindings(db, result.findings, result.createdAt, true, project.id);
      const run: ProjectRun = { result, weights, errors };
      this.cache.set("backend", `result:${project.id}`, run);
      this.projectRuns.set(project.id, run);
    } catch (err) {
      log(`${project.id}: scoring failed: ${errorText(err)}`);
    }
  }

  private projectPlugins(project: Project, base: ScoreResult): MetricPlugin[] {
    const { rubric, command, plan } = project.scorer;
    const resolved = () => {
      const ids = new Set(
        this.tasks(project.id)
          .filter((t) => (t.kind ?? "change") === "change" && (t.state === "pr_open" || t.state === "done"))
          .flatMap((t) => t.findingIds),
      );
      return (id: string) => ids.has(id);
    };
    return [
      sharedNeutralPlugin(base),
      ...(rubric ? [scanPlugin(rubricScan(project.id, rubric))] : []),
      ...(command?.length ? [commandPlugin(project.id, command)] : []),
      ...(plan ? [planPlugin(project.id, resolved())] : []),
    ];
  }

  private projectRun(id: string): ProjectRun | undefined {
    let run = this.projectRuns.get(id);
    if (!run) {
      run = this.cache.get<ProjectRun>("backend", `result:${id}`);
      if (run) this.projectRuns.set(id, run);
    }
    return run;
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

  /**
   * The project and its scores: Quality's latest result, a custom project's latest run, or (no
   * scorer or not scored yet) the shared tree with neutral metrics only.
   */
  private async view(projectId?: string): Promise<View> {
    const project = this.project(projectId);
    const result = await this.latest();
    const { config } = this.opts;
    if (hasScorer(project)) return { project, result, config, errors: [] };
    const run = isScored(project) ? this.projectRun(project.id) : undefined;
    if (run) return { project, result: run.result, config: { ...config, weights: run.weights }, errors: run.errors };
    if (this.unscoredView?.from !== result) this.unscoredView = { from: result, result: unscored(result) };
    return { project, result: this.unscoredView.result, config, errors: [] };
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

  /** Scan coverage of the project's scan (Quality's or its rubric's), none for projects without one. */
  private coverage({ project, result }: View): ApiOverview["coverage"] {
    if (!isScannable(project)) return NO_COVERAGE;
    let coverage = this.scanned.get(result);
    if (!coverage) this.scanned.set(result, (coverage = scanCoverage(this.collectCtx(result), scanKind(project))));
    return coverage;
  }

  /** Suggestions of a scored project, recomputed when its result or the busy paths change. */
  private suggestions({ project, result, config }: View): Suggestion[] {
    if (!isScored(project)) return [];
    const busy = this.busyPaths();
    const busyKey = busy.join("\0");
    const cached = this.derived.get(project.id);
    if (cached?.result === result && cached.busyKey === busyKey) return cached.suggestions;
    const suggestions = suggestTasks(result, config, busy);
    this.derived.set(project.id, { result, busyKey, suggestions });
    return suggestions;
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
      const status = /^unknown task/.test(message) ? 404 : /^(no checklist item|unknown phase|plan must|items are|scorer)/.test(message) ? 400 : 409;
      throw new HttpError(status, message);
    }
  }

  /** A change task of a plan project reached `pr_open` or `done`: rescore once so its items count as resolved. */
  private rescoreOnPlanProgress(task: Task): void {
    const finished = (task.kind ?? "change") === "change" && (task.state === "pr_open" || task.state === "done") && task.findingIds.length > 0;
    if (!finished || this.resolvedPlanTasks.has(task.id) || !getProject(this.opts.db, task.project)?.scorer.plan) return;
    this.resolvedPlanTasks.add(task.id);
    void this.rescore();
  }

  private emit(event: ServerEvent): void {
    if (event.type === "pr") event = { ...event, pr: this.withProject(event.pr) };
    if (event.type === "task") this.rescoreOnPlanProgress(event.task);
    for (const listener of this.listeners) listener(event);
  }
}

/** `scorer` with `parts` (rubric, command, plan) replaced; plugins are kept. */
function withParts(scorer: ScorerSpec, parts: ScorerSpec): ScorerSpec {
  return { ...(scorer.plugins && { plugins: scorer.plugins }), ...parts };
}

function scanKind(project: Project): ScanKind {
  return hasScorer(project) ? QUALITY_SCAN : rubricScan(project.id, project.scorer.rubric!);
}

/** `config.weights`, plus weight 1 for every other non-neutral metric of a custom project. */
function projectWeights(result: ScoreResult, config: Config): Record<string, number> {
  const scored = result.metricDefs.filter((d) => d.direction !== "neutral").map((d) => [d.key, 1]);
  return { ...Object.fromEntries(scored), ...config.weights };
}

/** The shared tree's neutral metrics (sizes, churn) from Quality's result, so project tiles keep their size. */
function sharedNeutralPlugin(base: ScoreResult): MetricPlugin {
  const { own, metricDefs } = unscored(base);
  return { id: "shared", metrics: metricDefs, collect: async () => own };
}

function planPrompt(): string {
  return [
    "Plan the work toward the project goal. Read the repository (read only: change and commit nothing) and break the goal into concrete work items.",
    'Report them with techtree_report {items: [{node, title, detail, effort, severity?}]}: node = the repo-relative directory the item mostly touches ("" = repo root),',
    "title = a short imperative, detail = what to do and why, effort = trivial | small | medium | large, severity = low | medium | high (importance).",
    "Prefer 5–20 items, each small enough for one PR.",
  ].join("\n");
}

function scorerPrompt(project: Project, result: ScoreResult, config: Config, scriptsDir: string): string {
  const metrics = result.metricDefs.filter((d) => d.direction !== "neutral").map((d) => d.label);
  const bySource = new Map<string, number>();
  for (const f of result.findings) bySource.set(f.source, (bySource.get(f.source) ?? 0) + 1);
  const top = [...result.findings]
    .sort((a, b) => (result.impacts[b.id]?.node ?? 0) - (result.impacts[a.id]?.node ?? 0))
    .slice(0, 10)
    .map((f) => `- ${f.title} (${f.source}, ${f.node || "root"})`);
  const quality = result.scores[""]?.quality;
  return [
    `${isScored(project) ? "Refine" : "Draft"} the scorer of this techtree project: how its progress toward the goal is measured on the repository tree.`,
    `Current scorer: ${JSON.stringify(withParts({}, project.scorer))}`,
    `Current scores: root composite ${quality === null || quality === undefined ? "none" : quality.toFixed(1)}; metrics: ${metrics.join(", ") || "none"}.`,
    `Current findings: ${[...bySource].map(([source, n]) => `${n} ${source}`).join(", ") || "none"}.${top.length ? `\n${top.join("\n")}` : ""}`,
    `A scorer combines: rubric (text telling an LLM scan of each file what to look for), command (argv run in the repo root, printing JSON ` +
      `{metrics: [{key, label, direction, unit?, aggregate?}], values: {"<path>": {"<key>": number}}, findings?: [{node or file, line?, title, detail, severity, effort?}]}, ` +
      `timeout ${Number(config.plugins.command?.timeoutMs) || 600000} ms) and plan (score progress on work items from plan tasks).`,
    `Write any scripts for the command in ${scriptsDir} (never in the repository) and test them.`,
    "Propose the scorer with techtree_report {scorer: {rubric?, command?, plan?}}; the user reviews it and may reply to iterate.",
  ].join("\n");
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
