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
  SCORER_PLUGINS,
  isScannable,
  isScored,
  listProjects,
  saveProject,
  scorerParts,
} from "../core/projects.ts";
import { score } from "../core/pipeline.ts";
import { dict } from "../core/tree.ts";
import { buildModel, findingImpact, findingsImpact } from "../core/scoring.ts";
import { nodeHistory, recordFindings, saveSnapshot } from "../core/store.ts";
import { suggestTasks } from "../core/suggest.ts";
import { dbCache, type Db } from "../db.ts";
import { repoId } from "../paths.ts";
import { defaultPlugins } from "../plugins/index.ts";
import { projectPlugins, projectWeights, sharedPlugins } from "../plugins/project.ts";
import { refineText, type RefineKind } from "./refine.ts";
import { QUALITY_SCAN, llmScanPlugin, rubricScan, scanCoverage, scanNode, type ScanKind } from "../plugins/llm-scan.ts";
import { addPlanItems, parsePlanItems, type PlanItem } from "../plugins/plan.ts";
import { listModels } from "./models.ts";
import { launchDetached, shellQuote, terminalArgv } from "./terminal.ts";
import { Babysitter } from "../prs/babysit.ts";
import { PrPoller, prRetired } from "../prs/poller.ts";
import { BundleConflict, listBundles, openBundle, saveBundle } from "../runner/bundle.ts";
import { TaskRunner } from "../runner/runner.ts";
import { HttpError, type Backend, type BundleInput, type ProjectInput, type WorkerReport } from "../server/backend.ts";
import type {
  ApiModels,
  ApiNode,
  ApiOverview,
  ApiPrs,
  ApiSource,
  ApiState,
  Bundle,
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
  autoBabysit(): boolean;
  setAutoBabysit(on: boolean): void | Promise<void>;
  /** Register a listener for `pr` / `pr_removed` events; returns the unsubscribe function. */
  onEvent(listener: (event: ServerEvent) => void): () => void;
}

export const noPrs: PrSource = {
  list: () => [],
  setBabysit: (number) => {
    throw new HttpError(404, `no PR #${number}`);
  },
  autoBabysit: () => false,
  setAutoBabysit: () => {
    throw new HttpError(404, "PRs are not polled");
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
const BUSY_TTL_MS = 15_000;
/** States whose task still claims its findings (DESIGN "Claimed findings"). */
const CLAIMING_STATES: Task["state"][] = [...LIVE_STATES, "review", "staged", "pr_open"];
const NO_COVERAGE: ApiOverview["coverage"] = { scannedNodes: 0, totalNodes: 0, scannedLoc: 0, totalLoc: 0 };
const RESULT_KEY = ["backend", "tree:v3"] as const;
const MODELS_TTL_MS = 10 * 60_000;

/** A project's latest scoring run (DESIGN "Project scorers"). */
interface ProjectRun {
  result: ScoreResult;
  /** Configured plugin weights and implicit weights for rubric, command and plan metrics. */
  weights: Record<string, number>;
  errors: string[];
  identity: string;
}

/** What a project's views are computed from. */
interface View {
  project: Project;
  result: ScoreResult;
  config: Config;
  errors: string[];
  dismissed: (Finding & { reason?: string })[];
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
  private busyCache?: { key: string; at: number; paths: string[] };
  private visibleView?: { from: ScoreResult; dismissedKey: string; result: ScoreResult };
  private scoring?: Promise<void>;
  private rescoreQueued = false;
  private reconciling = false;
  private scoreError?: string;
  private modelList?: { at: number; models: Promise<string[]> };

  constructor(opts: RepoBackendOptions) {
    this.opts = { plugins: [...defaultPlugins, llmScanPlugin], prs: noPrs, pollPrs: false, log: (msg) => console.error(msg), ...opts };
    this.cache = dbCache(opts.db);
    const shared = this.cache.get<{ result: ScoreResult; config: string }>(...RESULT_KEY);
    if (shared?.config === JSON.stringify(opts.config)) this.result = shared.result;
    this.unsubscribePrs = this.opts.prs.onEvent((event) => this.emit(event));
  }

  async listProjects(): Promise<Project[]> {
    return listProjects(this.opts.db);
  }

  async findings(ids: string[], projectId?: string): Promise<Finding[]> {
    const wanted = new Set(ids);
    return (await this.view(projectId)).result.findings.filter((f) => wanted.has(f.id));
  }

  async refine(input: { kind: RefineKind; text: string; name?: string; goal?: string }): Promise<{ text: string }> {
    try {
      return { text: await refineText(input, this.opts.config, this.opts.repoRoot) };
    } catch (err) {
      throw new HttpError(502, `refine failed: ${errorText(err)}`);
    }
  }

  async createProject({ name, goal }: ProjectInput): Promise<Project> {
    if (!name?.trim()) throw new HttpError(400, "name must not be empty");
    return createProject(this.opts.db, name.trim(), goal?.trim() || undefined);
  }

  async updateProject(id: string, { name, goal, scorer }: ProjectInput): Promise<Project> {
    const { goal: oldGoal, ...project } = this.project(id);
    if (name !== undefined && !name.trim()) throw new HttpError(400, "name must not be empty");
    const parts = scorer === undefined ? undefined : scorerParts(scorer);
    if (typeof parts === "string") throw new HttpError(400, parts);
    const nextGoal = goal === undefined ? oldGoal : goal.trim();
    const updated: Project = {
      ...project,
      ...(name !== undefined && { name: name.trim() }),
      ...(nextGoal && { goal: nextGoal }),
      ...(parts && { scorer: parts }),
    };
    saveProject(this.opts.db, updated);
    if (scorer) void this.rescore();
    return updated;
  }

  async deleteProject(id: string): Promise<void> {
    this.project(id);
    const tasks = this.runner().list().filter((t) => t.project === id);
    const prClosed = (t: Task) => t.pr !== undefined && prRetired(this.cache, t.pr);
    const blocking = tasks.find((t) => LIVE_STATES.includes(t.state) || (t.state === "pr_open" && !prClosed(t)));
    if (blocking) throw new HttpError(409, `task ${blocking.id} is ${blocking.state}; cancel it or close its PR first`);
    for (const task of tasks) this.runnerCall(() => this.runner().discard(task.id, { prClosed: prClosed(task) }));
    deleteProjectRows(this.opts.db, id);
    this.opts.db.prepare("DELETE FROM cache WHERE (kind = 'backend' AND key = ?) OR (kind = 'plan' AND key = ?) OR substr(kind, 1, length(?)) = ?").run(`result:${id}`, id, `rubric:${id}:`, `rubric:${id}:`);
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
    if (!this.result || this.result.sha !== git(repoRoot, "rev-parse", "HEAD").trim() || listProjects(db).some((p) => isScored(p) && !this.projectRun(p))) void this.rescore();
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
      onPolled: () => void this.reconcileBundles(),
    });
    const babysitter = new Babysitter({ poller, runner, cache: this.cache });
    this.opts.prs = {
      list: () => poller.list(),
      setBabysit: (n, on) => babysitter.setBabysit(n, on),
      autoBabysit: () => babysitter.autoBabysit,
      setAutoBabysit: (on) => babysitter.setAutoBabysit(on),
      onEvent: () => () => {},
    };
    this.stopPrPolling = () => poller.stop();
    poller.start();
  }

  /**
   * Settle every bundle whose PR is retired (merged or closed) while its tasks are still `pr_open`;
   * run after each poll, so a missed removal or a failed lookup is retried (DESIGN "Staging and combined PRs").
   */
  async reconcileBundles(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const runner = this.runner();
      const pending = listBundles(this.opts.db).filter(
        (b) => prRetired(this.cache, b.pr) && b.taskIds.some((id) => runner.get(id)?.state === "pr_open"),
      );
      for (const bundle of pending) await this.settleBundle(runner, bundle);
    } finally {
      this.reconciling = false;
    }
  }

  private async settleBundle(runner: TaskRunner, bundle: Bundle): Promise<void> {
    let state: string;
    try {
      ({ stdout: state } = await promisify(execFile)("gh", ["pr", "view", String(bundle.pr), "--json", "state", "--jq", ".state"], { cwd: this.opts.repoRoot }));
    } catch (err) {
      return this.opts.log(`bundle PR #${bundle.pr}: ${errorText(err)}`);
    }
    if (state.trim() === "OPEN") return;
    const merged = state.trim() === "MERGED";
    if (merged) {
      const findingIds = bundle.taskIds.flatMap((id) => runner.get(id)?.findingIds ?? []);
      const resolve = this.opts.db.prepare("UPDATE findings SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL");
      for (const id of findingIds) resolve.run(new Date().toISOString(), id);
    }
    runner.bundleClosed(bundle.taskIds, merged);
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

  async stage(taskId: string): Promise<Task> {
    return this.runnerCall(() => this.runner().stage(taskId));
  }

  async unstage(taskId: string): Promise<Task> {
    return this.runnerCall(() => this.runner().unstage(taskId));
  }

  async listBundles(projectId?: string): Promise<Bundle[]> {
    return listBundles(this.opts.db, this.project(projectId).id);
  }

  async createBundle({ project: projectId, taskIds, title }: BundleInput): Promise<Bundle> {
    const project = this.project(projectId);
    if (!taskIds.length) throw new HttpError(400, "taskIds must not be empty");
    const tasks = taskIds.map((id) => this.task(id));
    const wrong = tasks.find((t) => t.state !== "staged" || t.project !== project.id);
    if (wrong) throw new HttpError(409, `task ${wrong.id} is ${wrong.state} in ${wrong.project}, not staged in ${project.id}`);
    tasks.sort((a, b) => (a.stagedAt ?? "").localeCompare(b.stagedAt ?? ""));
    const findings = new Map((this.projectRun(project)?.result.findings ?? []).map((f) => [f.id, f.title]));
    const { repoRoot, config, db } = this.opts;
    let bundle: Bundle;
    try {
      bundle = await openBundle({
        repoRoot,
        config,
        project: project.id,
        tasks,
        ...(title && { title }),
        findingTitles: (task) => task.findingIds.map((id) => findings.get(id) ?? id),
      });
    } catch (err) {
      throw new HttpError(err instanceof BundleConflict ? 409 : 502, errorText(err));
    }
    saveBundle(db, bundle);
    this.runner().bundled(bundle.taskIds, bundle.id, bundle.pr);
    return bundle;
  }

  async dismiss(findingIds: string[], reason?: string, projectId?: string): Promise<void> {
    const project = this.project(projectId).id;
    const insert = this.opts.db.prepare(
      "INSERT INTO dismissals (finding_id, project, reason, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (finding_id) DO UPDATE SET reason = excluded.reason",
    );
    for (const id of findingIds) insert.run(id, project, reason ?? null, new Date().toISOString());
    this.announceFindingsChanged();
  }

  async undismiss(findingIds: string[]): Promise<void> {
    const remove = this.opts.db.prepare("DELETE FROM dismissals WHERE finding_id = ?");
    for (const id of findingIds) remove.run(id);
    this.announceFindingsChanged();
  }

  /** Clients refetch state and details on `scores`, which is what a (un)dismissal needs. */
  private announceFindingsChanged(): void {
    if (this.result) this.emit({ type: "scores", snapshot: { sha: this.result.sha, createdAt: this.result.createdAt } });
  }

  async getState(projectId?: string): Promise<ApiState> {
    const view = await this.view(projectId);
    const { project, result, config } = view;
    const findingCounts = dict<number>();
    for (const f of result.findings) findingCounts[f.node] = (findingCounts[f.node] ?? 0) + 1;
    const suggestionCounts = dict<number>();
    // Conflict changes ordering, not counts; avoid polling worktree diffs just to count suggestions.
    for (const s of this.suggestions(view, [])) suggestionCounts[s.node] = (suggestionCounts[s.node] ?? 0) + 1;
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
      suggestionCounts,
    };
  }

  async getNode(id: NodeId, projectId?: string): Promise<ApiNode> {
    const view = await this.view(projectId);
    const { project, result, dismissed } = view;
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
      dismissed: dismissed.filter((f) => f.node === id),
      ...nodeCtas(id, rankCtas(tasks, prs, suggestions)),
    };
  }

  async getOverview(projectId?: string): Promise<ApiOverview> {
    const all = projectId === ALL_PROJECTS;
    const view = all ? (getProject(this.opts.db, QUALITY) ? await this.view(QUALITY) : undefined) : await this.view(projectId);
    const scope = all ? undefined : view!.project.id;
    const suggestions = all
      ? interleave(
          await Promise.all(
            listProjects(this.opts.db).map(async (p) => this.suggestions(await this.view(p.id)).map((s) => ({ ...s, project: p.id }))),
          ),
        )
      : this.suggestions(view!);
    return {
      attentionTasks: this.tasks(scope).filter((t) => t.state === "needs_input" || t.state === "review"),
      stagedTasks: this.tasks(scope)
        .filter((t) => t.state === "staged")
        .sort((a, b) => (a.stagedAt ?? "").localeCompare(b.stagedAt ?? "")),
      activeTasks: this.tasks(scope).filter((t) => t.state === "queued" || t.state === "running"),
      flaggedPrs: this.prs(scope).filter((p) => p.ci === "fail" || p.stuck || p.stale),
      suggestions: suggestions.slice(0, OVERVIEW_SUGGESTIONS),
      coverage: view ? this.coverage(view) : NO_COVERAGE,
      ...(!all && view!.errors.length && { scorerErrors: view!.errors }),
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
    saveProject(this.opts.db, { ...project, scorer: task.proposal! });
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

  async listPrs(): Promise<ApiPrs> {
    const prs = this.prs();
    const linked = new Set(prs.map((pr) => pr.taskId));
    return { prs, tasks: this.runner().list().filter((t) => linked.has(t.id)), autoBabysit: this.opts.prs.autoBabysit() };
  }

  async setAutoBabysit(on: boolean): Promise<ApiPrs> {
    try {
      await this.opts.prs.setAutoBabysit(on);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(502, errorText(err));
    }
    return this.listPrs();
  }

  /** Start a scoring run (or queue one behind the run in progress); completion is a `scores` event. */
  async rescore(projectId?: string): Promise<void> {
    if (projectId !== undefined) this.project(projectId);
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
      const result = unscored(await score({ repoRoot, config, plugins: sharedPlugins(plugins), cache: this.cache, log }));
      this.cache.set(...RESULT_KEY, { result, config: JSON.stringify(config) });
      this.result = result;
      this.scoreError = undefined;
      for (const project of listProjects(db)) if (isScored(project)) await this.scoreProject(project, result);
      this.emit({ type: "scores", snapshot: { sha: result.sha, createdAt: result.createdAt } });
    } catch (err) {
      this.scoreError = errorText(err);
      log(`scoring failed: ${this.scoreError}`);
    }
  }

  /** Score a project over the shared tree; collection failures are kept as its errors. */
  private async scoreProject(project: Project, base: ScoreResult): Promise<void> {
    const { db, repoRoot, config, log } = this.opts;
    const errors: string[] = [];
    const onLog = (msg: string) => {
      log(`${project.id}: ${msg}`);
      if (msg.includes(": collect failed: ")) errors.push(msg);
    };
    try {
      const raw = await score({ repoRoot, config, plugins: this.projectPlugins(project, base), cache: this.cache, log: onLog, tree: base.tree });
      const weights = projectWeights(raw, config, project, this.opts.plugins);
      const model = buildModel(raw.tree, raw.metricDefs, raw.own, { ...config, weights });
      const impacts = Object.fromEntries(raw.findings.map((f) => [f.id, findingImpact(model, f)]));
      const result: ScoreResult = { ...raw, sha: base.sha, scores: model.scores, impacts };
      const identity = projectIdentity(project, config);
      const current = getProject(db, project.id);
      if (!current || projectIdentity(current, config) !== identity) return;
      saveSnapshot(db, result, project.id);
      recordFindings(db, result.findings, result.createdAt, true, project.id);
      const run: ProjectRun = { result, weights, errors, identity };
      this.cache.set("backend", `result:${project.id}`, run);
      this.projectRuns.set(project.id, run);
    } catch (err) {
      log(`${project.id}: scoring failed: ${errorText(err)}`);
    }
  }

  private projectPlugins(project: Project, base: ScoreResult): MetricPlugin[] {
    const resolved = () => {
      const ids = new Set(
        this.tasks(project.id)
          .filter((t) => (t.kind ?? "change") === "change" && (t.state === "pr_open" || t.state === "done"))
          .flatMap((t) => t.findingIds),
      );
      return (id: string) => ids.has(id);
    };
    return projectPlugins(project, this.opts.plugins, base, resolved());
  }

  private projectRun(project: Project): ProjectRun | undefined {
    const run = this.projectRuns.get(project.id) ?? this.cache.get<ProjectRun>("backend", `result:${project.id}`);
    if (!run || run.identity !== projectIdentity(project, this.opts.config)) return undefined;
    this.projectRuns.set(project.id, run);
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
   * The project's latest matching run, without
   * dismissed findings (listed apart); with no scorer or not scored yet, the shared tree with neutral
   * metrics only.
   */
  private async view(projectId?: string): Promise<View> {
    const project = this.project(projectId);
    const latest = await this.latest();
    const { config } = this.opts;
    const run = isScored(project) ? this.projectRun(project) : undefined;
    if (!run) {
      return { project, result: latest, config, errors: [], dismissed: [] };
    }
    const result = run.result;
    const reasons = this.dismissals();
    const dismissedKey = [...reasons.keys()].join("\0");
    if (this.visibleView?.from !== result || this.visibleView.dismissedKey !== dismissedKey) {
      this.visibleView = { from: result, dismissedKey, result: { ...result, findings: result.findings.filter((f) => !reasons.has(f.id)) } };
    }
    const dismissed = result.findings.filter((f) => reasons.has(f.id)).map((f) => ({ ...f, ...(reasons.get(f.id) && { reason: reasons.get(f.id)! }) }));
    return { project, result: this.visibleView.result, config: { ...config, weights: run.weights }, errors: run.errors, dismissed };
  }

  /** Dismissed finding ids and their reasons (DESIGN "Dismissed findings"). */
  private dismissals(): Map<string, string | null> {
    const rows = this.opts.db.prepare("SELECT finding_id, reason FROM dismissals ORDER BY finding_id").all() as { finding_id: string; reason: string | null }[];
    return new Map(rows.map((r) => [r.finding_id, r.reason]));
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
    const project = (pr.taskId && this.taskRunner?.get(pr.taskId)?.project) || listBundles(this.opts.db).find((b) => b.pr === pr.number)?.project;
    return { ...pr, project: project || QUALITY };
  }

  /** Scan coverage of the project's scan (Quality's or its rubric's), none for projects without one. */
  private coverage({ project, result }: View): ApiOverview["coverage"] {
    if (!isScannable(project)) return NO_COVERAGE;
    let coverage = this.scanned.get(result);
    if (!coverage) this.scanned.set(result, (coverage = scanCoverage(this.collectCtx(result), scanKind(project))));
    return coverage;
  }

  /** Suggestions of a scored project, recomputed when its result or the busy paths change. */
  private suggestions({ project, result, config }: View, busyPaths?: string[]): Suggestion[] {
    if (!isScored(project)) return [];
    const busy = busyPaths ?? this.busyPaths();
    const claimed = new Set(this.tasks(project.id).flatMap((t) => (CLAIMING_STATES.includes(t.state) ? t.findingIds : [])));
    const busyKey = [...busy, "", ...[...claimed].sort()].join("\0");
    const cached = this.derived.get(project.id);
    if (cached?.result === result && cached.busyKey === busyKey) return cached.suggestions;
    const suggestions = suggestTasks(result, config, busy).filter((s) => !s.findingIds.some((id) => claimed.has(id)));
    this.derived.set(project.id, { result, busyKey, suggestions });
    return suggestions;
  }

  private busyPaths(): string[] {
    const worktrees = this.runner()
      .list()
      .flatMap((t) => (t.worktree && LIVE_STATES.includes(t.state) ? [t.worktree] : []));
    const key = worktrees.join("\0");
    // ponytail: a live task's edits show up in conflicts up to BUSY_TTL_MS late; watch worktrees if that matters.
    if (this.busyCache?.key !== key || Date.now() - this.busyCache.at > BUSY_TTL_MS) {
      const changed = new Set<string>();
      if (worktrees.length) {
        const base = git(this.opts.repoRoot, "rev-parse", this.opts.config.baseRef).trim();
        for (const worktree of worktrees) for (const file of git(worktree, "diff", "--name-only", "-z", base).split("\0")) if (file) changed.add(file);
      }
      this.busyCache = { key, at: Date.now(), paths: [...changed] };
    }
    const paths = new Set(this.busyCache.paths);
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

function projectIdentity(project: Project, config: Config): string {
  return JSON.stringify([project.createdAt, project.scorer, config]);
}

function scanKind(project: Project): ScanKind {
  return project.scorer.rubric ? rubricScan(project.id, project.scorer.rubric) : QUALITY_SCAN;
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
    `Current scorer: ${JSON.stringify(project.scorer)}`,
    `Available metric plugins: ${SCORER_PLUGINS.join(", ")}. plugins selects only these; omit or use [] to remove them. A rubric overrides llm-scan's default focus.`,
    "slop requires rust to supply test counts; retain both or remove slop too.",
    `Current scores: root composite ${quality === null || quality === undefined ? "none" : quality.toFixed(1)}; metrics: ${metrics.join(", ") || "none"}.`,
    `Current findings: ${[...bySource].map(([source, n]) => `${n} ${source}`).join(", ") || "none"}.${top.length ? `\n${top.join("\n")}` : ""}`,
    `A scorer combines: rubric (text telling an LLM scan of each file what to look for), command (argv run in the repo root, printing JSON ` +
      `{metrics: [{key, label, direction: "lower_better"|"higher_better"|"neutral", unit?, aggregate?: "sum" (default)|"max"|"mean_by_loc"}], ` +
      `values: {"<repo-relative file or directory>": {"<key>": number}} (a file's values count toward its directories), ` +
      `findings?: [{node or file, line?, title, detail, severity: "low"|"medium"|"high", effort?: "trivial"|"small"|"medium"|"large", metricEffects?: {"<key>": expected change if fixed, e.g. -12}}]} (without metricEffects a finding is credited an even share of its path's lower_better values), ` +
      `timeout ${Number(config.plugins.command?.timeoutMs) || 600000} ms) and plan (score progress on work items from plan tasks).`,
    `Write any scripts for the command in ${scriptsDir} (never in the repository) and test them.`,
    "Propose the complete replacement scorer with techtree_report {scorer: {plugins?, rubric?, command?, plan?}}; omitted parts are removed. The user reviews it and may reply to iterate.",
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
