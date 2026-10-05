import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { QUALITY } from "../core/projects.ts";
import type { Db } from "../db.ts";
import type { ChatEntry, Config, ServerEvent, StartTaskRequest, Task, TaskPhase, TaskState } from "../types.ts";
import type { ReportPayload } from "./report-tool.ts";
import { assistantText, describeRpcRecord, isAssistantMessageEnd, toolCall, type RpcRecord } from "./rpc-log.ts";

export interface TaskRunnerOptions {
  db: Db;
  config: Config;
  repoRoot: string;
  cacheDir: string;
  /** Server base URL and token handed to workers for `techtree_report`. */
  url: string;
  token: string;
  onEvent?: (event: ServerEvent) => void;
  /** Directory holding `extensions/` and `skills/`; defaults to this package. */
  packageRoot?: string;
}

export type StartTask = StartTaskRequest & {
  plannedFrom: number;
  plannedTo: number;
  /** Adopt this existing PR (babysit): check it out instead of branching, send the prompt as given. */
  pr?: number;
  /** Project context put before the prompt (DESIGN "Projects"). */
  brief?: string;
};

interface Dialog {
  id: string;
  method: string;
  timer?: NodeJS.Timeout;
}

interface Worker {
  child: ChildProcess;
  dialog?: Dialog;
  nudged: boolean;
  lastText: string;
  /** Prompts written but not yet acknowledged; an `agent_settled` seen meanwhile predates them. */
  unacknowledgedPrompts: number;
  /** Prompts written so far; a finish check that started before the latest one is stale. */
  promptsSent: number;
}

const PHASES: TaskPhase[] = ["plan", "explore", "edit", "test", "pr"];
const LIVE_STATES: TaskState[] = ["queued", "running", "needs_input"];
const RESUMABLE_BY_MESSAGE: TaskState[] = ["review", "failed", "pr_open"];
const KILL_GRACE_MS = 1_000;
const FINISH_GRACE_MS = 5_000;

const CONTINUE_PROMPT = "techtree restarted. Continue the task where you left off.";
const PR_LOOKUP_TIMEOUT_MS = 60_000;
const PR_CHECKOUT_TIMEOUT_MS = 300_000;
const NUDGE_PROMPT =
  "You stopped before the task was finished (checklist incomplete, or no PR found where one is required). " +
  "Continue the task. If you are blocked, call techtree_report with {needs_input: question}.";

/** Runs techtree tasks as `pi --mode rpc` children in their own worktrees. See docs/DESIGN.md "Agents". */
export class TaskRunner {
  private readonly opts: TaskRunnerOptions;
  private readonly tasks = new Map<string, Task>();
  private readonly workers = new Map<string, Worker>();
  /** First prompt for queued tasks that resume an existing worktree and session. */
  private readonly resumePrompts = new Map<string, string>();
  private readonly packageRoot: string;
  /** Tasks holding a worker slot while `gh pr checkout` prepares their worktree. */
  private readonly checkingOut = new Set<string>();
  /** Stopped workers that have not exited yet, by task; their session is still busy. */
  private readonly exiting = new Map<string, ChildProcess>();
  private closed = false;
  private recovering = false;

  constructor(opts: TaskRunnerOptions) {
    this.opts = opts;
    this.packageRoot = opts.packageRoot ?? findPackageRoot();
    const rows = opts.db.prepare("SELECT data FROM tasks").all() as { data: string }[];
    const loaded = rows.map((r) => ({ project: QUALITY, ...(JSON.parse(r.data) as Omit<Task, "project">) }) as Task).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of loaded) this.tasks.set(task.id, task);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  start(req: StartTask): Task {
    const now = new Date().toISOString();
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const title = req.title ?? `Improve ${req.node || "the repository root"}`;
    const task: Task = {
      id,
      project: req.project ?? QUALITY,
      node: req.node,
      title,
      prompt: [req.brief, req.prompt ?? defaultPrompt(title, req)].filter(Boolean).join("\n\n"),
      findingIds: req.findingIds,
      state: "queued",
      ...(req.pr !== undefined && { pr: req.pr }),
      manualReview: req.manualReview,
      ...(req.model && { model: req.model }),
      plannedFrom: req.plannedFrom,
      plannedTo: req.plannedTo,
      checklist: [],
      phase: "plan",
      logPath: join(this.opts.cacheDir, "tasks", `${id}.log`),
      createdAt: now,
      updatedAt: now,
    };
    this.save(task);
    this.pump();
    return task;
  }

  /** Apply a `techtree_report` payload from the task's worker. */
  report(taskId: string, payload: ReportPayload): Task {
    const task = this.require(taskId);
    if (task.state !== "running" && task.state !== "needs_input") throw new Error(`task ${taskId} is ${task.state}`);
    const worker = this.workers.get(taskId);
    if (!worker) throw new Error(`task ${taskId} has no live worker`);
    const { plan, phase, done, needs_input, outcome, summary, dismiss, reason } = payload;
    if (phase !== undefined && !PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
    if (plan !== undefined && !Array.isArray(plan)) throw new Error("plan must be a list of steps");
    const checklist = plan ? plan.map((text) => ({ text: String(text), done: false })) : task.checklist;
    if (done !== undefined && !(Number.isInteger(done) && done >= 0 && done < checklist.length))
      throw new Error(`no checklist item ${done}`);
    task.checklist = checklist;
    if (phase) task.phase = phase;
    if (done !== undefined) checklist[done].done = true;
    if (dismiss?.length) task.proposedDismiss = { findingIds: dismiss, ...(reason && { reason }) };
    if (needs_input) {
      task.state = "needs_input";
      task.question = needs_input;
    }
    worker.nudged = false;
    this.log(task, `report: ${JSON.stringify(payload)}`);
    if (outcome === "no_change") {
      this.stop(task, worker, "done", summary || worker.lastText);
      return task;
    }
    this.save(task);
    return task;
  }

  /** Answer a `needs_input` question or dialog and resume the worker. */
  answer(taskId: string, text: string): Task {
    const task = this.require(taskId);
    if (task.state !== "needs_input") throw new Error(`task ${taskId} is not waiting for input`);
    task.question = undefined;
    this.log(task, `answer: ${text}`);
    const worker = this.workers.get(taskId);
    if (!worker) {
      this.resume(task, text);
      return task;
    }
    task.state = "running";
    worker.nudged = false;
    if (worker.dialog) {
      send(worker, dialogResponse(worker.dialog, text));
      this.chatEntry(task, "user", text);
      clearDialog(worker);
    } else {
      this.prompt(task, worker, text);
    }
    this.save(task);
    return task;
  }

  /** Move a `review` task into the PR stage by resuming its worker session. */
  openPr(taskId: string): Task {
    const task = this.require(taskId);
    if (task.state !== "review") throw new Error(`task ${taskId} is ${task.state}, not review`);
    task.phase = "pr";
    this.resume(task, openPrPrompt(task));
    return task;
  }

  /** Put a `review` task aside for a combined PR (DESIGN "Staging and combined PRs"). */
  stage(taskId: string): Task {
    const task = this.require(taskId);
    if (task.state !== "review") throw new Error(`task ${taskId} is ${task.state}, not review`);
    task.state = "staged";
    task.stagedAt = new Date().toISOString();
    this.save(task);
    return task;
  }

  unstage(taskId: string): Task {
    const task = this.require(taskId);
    if (task.state !== "staged") throw new Error(`task ${taskId} is ${task.state}, not staged`);
    task.state = "review";
    task.stagedAt = undefined;
    this.save(task);
    return task;
  }

  /** Staged tasks now in bundle `bundleId`'s combined PR `pr`. */
  bundled(taskIds: string[], bundleId: string, pr: number): void {
    for (const id of taskIds) {
      const task = this.require(id);
      Object.assign(task, { state: "pr_open", pr, bundle: bundleId, stagedAt: undefined });
      this.save(task);
    }
  }

  /** A bundle's PR left the open list: merged → `done`, closed → back to `review`. */
  bundleClosed(taskIds: string[], merged: boolean): void {
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (!task || task.state !== "pr_open") continue;
      if (merged) task.state = "done";
      else Object.assign(task, { state: "review", pr: undefined, bundle: undefined });
      this.save(task);
    }
  }

  /** Respawn a `pr_open` task on its session with `prompt` (babysit), through the queue. */
  resumeTask(taskId: string, prompt: string): Task {
    const task = this.require(taskId);
    if (task.state !== "pr_open" || !task.worktree) throw new Error(`task ${taskId} is ${task.state}, not pr_open with a worktree`);
    this.resume(task, prompt);
    return task;
  }

  /**
   * Message the task's agent from the chat pane: steer a live worker, answer a question, or resume
   * a `review`, `failed` or `pr_open` task on its session with `text` as the prompt.
   */
  message(taskId: string, text: string): Task {
    const task = this.require(taskId);
    if (task.state === "needs_input") return this.answer(taskId, text);
    const worker = this.workers.get(taskId);
    if (task.state === "running" && worker) {
      worker.nudged = false;
      this.prompt(task, worker, text, "steer");
      return task;
    }
    if (!RESUMABLE_BY_MESSAGE.includes(task.state) && task.outcome !== "no_change")
      throw new Error(`task ${taskId} is ${task.state}${task.state === "running" ? " and its worker has not started yet" : ""}`);
    if (!task.worktree) throw new Error(`task ${taskId} has no worktree`);
    if (!this.hasSession(task)) throw new Error(`task ${taskId} has no pi session`);
    Object.assign(task, { error: undefined, outcome: undefined, summary: undefined });
    this.resume(task, text);
    return task;
  }

  /** The task's chat transcript, oldest first. */
  chat(taskId: string): ChatEntry[] {
    const path = this.chatPath(this.require(taskId));
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChatEntry);
  }

  /** Argv for interactive pi on the task's session; refused while a worker owns that session. */
  agentCommand(taskId: string): string[] {
    const task = this.require(taskId);
    if (LIVE_STATES.includes(task.state)) throw new Error(`task ${taskId} has a live worker; cancel it first`);
    if (this.exiting.has(taskId)) throw new Error(`task ${taskId}'s worker is still shutting down; try again in a moment`);
    return [...this.opts.config.piCommand, ...this.sessionArgs(task)];
  }

  /** Stop the task's run. A run on an existing PR (babysit, fix) returns to `pr_open`; any other task fails with `cancelled`. */
  cancel(taskId: string): Task {
    const task = this.require(taskId);
    if (task.pr === undefined) {
      this.fail(task, "cancelled");
      return task;
    }
    this.stopWorker(task);
    task.state = "pr_open";
    task.question = undefined;
    this.log(task, "cancelled; back to pr_open");
    this.save(task);
    this.pump();
    return task;
  }

  /** Throw away a task that should never become a PR: stop it, remove its worktree, local branch, log, session and row. */
  discard(taskId: string, { prClosed = false } = {}): void {
    const task = this.require(taskId);
    if (task.state === "pr_open" && !prClosed) throw new Error(`task ${taskId} has an open PR; close it on GitHub first`);
    this.stopWorker(task);
    this.checkingOut.delete(task.id);
    if (task.worktree) tryGit(this.opts.repoRoot, "worktree", "remove", "--force", task.worktree);
    if (task.branch) tryGit(this.opts.repoRoot, "branch", "-D", task.branch);
    if (task.logPath) rmSync(task.logPath, { force: true });
    rmSync(this.chatPath(task), { force: true });
    rmSync(this.sessionDir(task), { recursive: true, force: true });
    this.tasks.delete(task.id);
    this.opts.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    this.opts.onEvent?.({ type: "task_removed", taskId: task.id });
    this.pump();
  }

  /** `git diff <baseRef>...HEAD` in the task's worktree. */
  diff(taskId: string): string {
    const task = this.require(taskId);
    if (!task.worktree) return "";
    return git(task.worktree, "diff", `${this.baseSha()}...HEAD`);
  }

  /** Resume or fail tasks whose worker belonged to a previous server. Call once on server start. */
  recover(): void {
    this.recovering = true;
    for (const task of this.tasks.values()) {
      const resumable = task.state === "running" || task.state === "needs_input" || (task.state === "queued" && task.worktree);
      if (!resumable) continue;
      if (task.pid) killOrphanedWorker(task.pid, task.id);
      task.pid = undefined;
      if (!this.hasSession(task)) this.fail(task, `worker lost on restart; log: ${task.logPath}`);
      else if (task.state === "running") this.resume(task, CONTINUE_PROMPT);
      else this.save(task);
    }
    this.recovering = false;
    this.pump();
  }

  /** Detach from all workers without changing task state; their pi processes exit when stdin closes. */
  close(): void {
    this.closed = true;
    for (const worker of this.workers.values()) {
      clearDialog(worker);
      worker.child.stdin?.end();
    }
    this.workers.clear();
  }

  private require(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  /** Queue a task that already has a worktree and session; it respawns with `prompt` when a slot frees. */
  private resume(task: Task, prompt: string): void {
    task.state = "queued";
    this.resumePrompts.set(task.id, prompt);
    this.save(task);
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.recovering) return;
    for (const task of this.tasks.values()) {
      if (this.workers.size + this.checkingOut.size >= this.opts.config.workers) return;
      if (task.state === "queued" && !this.exiting.has(task.id)) this.launch(task);
    }
  }

  private launch(task: Task): void {
    if (task.worktree) {
      const prompt = this.resumePrompts.get(task.id) ?? (task.phase === "pr" && task.manualReview ? openPrPrompt(task) : CONTINUE_PROMPT);
      this.resumePrompts.delete(task.id);
      task.state = "running";
      this.save(task);
      this.spawnWorker(task, prompt);
      return;
    }
    task.state = "running";
    void this.launchNew(task);
  }

  /** Create the worktree (and check the PR out for babysit tasks) without blocking the event loop, then start the worker if still wanted. */
  private async launchNew(task: Task): Promise<void> {
    this.checkingOut.add(task.id);
    this.save(task);
    const { path, branch } = this.worktreeFor(task);
    const run = promisify(execFile);
    try {
      if (task.pr === undefined) {
        await run("git", ["worktree", "add", "-b", branch, path, this.opts.config.baseRef], { cwd: this.opts.repoRoot });
      } else {
        await run("git", ["worktree", "add", "--detach", path, this.opts.config.baseRef], { cwd: this.opts.repoRoot });
        await run("gh", ["pr", "checkout", String(task.pr), "--branch", branch], { cwd: path, timeout: PR_CHECKOUT_TIMEOUT_MS });
      }
    } catch (err) {
      this.checkingOut.delete(task.id);
      if (task.state === "running" && this.tasks.has(task.id)) this.fail(task, `worktree: ${(err as Error).message}`);
      else this.pump();
      return;
    }
    this.checkingOut.delete(task.id);
    if (!this.tasks.has(task.id)) {
      // Discarded during checkout.
      tryGit(this.opts.repoRoot, "worktree", "remove", "--force", path);
      tryGit(this.opts.repoRoot, "branch", "-D", branch);
      return this.pump();
    }
    this.useWorktree(task, path, branch);
    if (task.state !== "running" || this.closed) return this.pump();
    this.spawnWorker(task, task.pr === undefined ? `/skill:techtree-worker ${task.prompt}\n\n${finishRule(task)}` : task.prompt);
  }

  private worktreeFor(task: Task): { path: string; branch: string } {
    const path = this.opts.config.worktreeTemplate
      .replaceAll("{home}", homedir())
      .replaceAll("{repo}", basename(this.opts.repoRoot))
      .replaceAll("{task}", task.id);
    mkdirSync(dirname(path), { recursive: true });
    return { path, branch: `techtree/${task.id}` };
  }

  private useWorktree(task: Task, path: string, branch: string): void {
    task.worktree = path;
    task.branch = branch;
    this.log(task, `worktree ${path} on ${branch}`);
    this.save(task);
  }

  private sessionDir(task: Task): string {
    return join(this.opts.cacheDir, "sessions", task.id);
  }

  private sessionArgs(task: Task): string[] {
    return ["--session-dir", this.sessionDir(task), "--session-id", task.id, ...(task.model ? ["--model", task.model] : [])];
  }

  private chatPath(task: Task): string {
    return join(this.opts.cacheDir, "tasks", `${task.id}.chat.jsonl`);
  }

  private hasSession(task: Task): boolean {
    const dir = this.sessionDir(task);
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"));
  }

  private spawnWorker(task: Task, message: string): void {
    const [command, ...prefix] = this.opts.config.piCommand;
    mkdirSync(this.sessionDir(task), { recursive: true });
    const args = [
      ...prefix,
      "--mode", "rpc",
      ...(this.opts.config.piLoadsExtension ? [] : ["-e", join(this.packageRoot, "extensions")]),
      "--skill", join(this.packageRoot, "skills", "techtree-worker"),
      "--skill", join(this.packageRoot, "skills", "techtree-babysit"),
      ...this.sessionArgs(task),
    ];
    const child = spawn(command, args, {
      cwd: task.worktree,
      env: { ...process.env, TECHTREE_URL: this.opts.url, TECHTREE_TOKEN: this.opts.token, TECHTREE_TASK: task.id },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: Worker = { child, nudged: false, lastText: "", unacknowledgedPrompts: 0, promptsSent: 0 };
    this.workers.set(task.id, worker);
    task.pid = child.pid;
    this.save(task);

    let ended = false;
    const onEnd = (reason: string) => {
      if (ended) return;
      ended = true;
      if (this.workers.get(task.id) !== worker) return;
      this.fail(task, `worker ${reason}; log: ${task.logPath}`);
    };
    child.on("error", (err) => onEnd(`failed to start: ${err.message}`));
    child.on("exit", (code, signal) => onEnd(`exited (${signal ?? code})`));
    splitLines(child.stdout!, (line) => this.onRecord(task, worker, line));
    splitLines(child.stderr!, (line) => this.log(task, `stderr: ${line}`));
    child.stdin!.on("error", () => {});
    this.prompt(task, worker, message);
  }

  private prompt(task: Task, worker: Worker, message: string, streamingBehavior: "followUp" | "steer" = "followUp"): void {
    this.log(task, `prompt: ${message}`);
    this.chatEntry(task, "user", message);
    worker.unacknowledgedPrompts++;
    worker.promptsSent++;
    send(worker, { type: "prompt", message, streamingBehavior });
  }

  private onRecord(task: Task, worker: Worker, line: string): void {
    if (this.workers.get(task.id) !== worker) return;
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      this.log(task, `stdout: ${line}`);
      return;
    }
    const text = describeRpcRecord(record);
    if (text) this.log(task, text);
    if (record.type === "response" && record.command === "prompt") {
      worker.unacknowledgedPrompts--;
      if (record.success === false) return this.fail(task, `pi rejected the prompt: ${record.error}`);
    }
    if (isAssistantMessageEnd(record)) {
      worker.lastText = assistantText(record.message);
      if (worker.lastText) this.chatEntry(task, "assistant", worker.lastText);
    }
    if (record.type === "tool_execution_start") this.chatEntry(task, "tool", toolCall(record));
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      this.openDialog(task, worker, record);
    }
    if (record.type === "agent_settled" && worker.unacknowledgedPrompts === 0) {
      // A dialog blocks the agent, so settling proves pi already resolved it (e.g. by its timeout).
      if (worker.dialog) this.dropDialog(task, worker, "dialog resolved without an answer");
      if (task.state === "running") void this.onSettled(task, worker);
    }
  }

  private openDialog(task: Task, worker: Worker, record: RpcRecord): void {
    clearDialog(worker);
    worker.dialog = { id: record.id, method: record.method };
    if (record.timeout)
      worker.dialog.timer = setTimeout(() => this.dropDialog(task, worker, "dialog timed out"), record.timeout);
    task.state = "needs_input";
    task.question = [record.title, typeof record.message === "string" && record.message, record.options?.join(" / ")]
      .filter(Boolean)
      .join("\n");
    this.save(task);
  }

  private dropDialog(task: Task, worker: Worker, reason: string): void {
    clearDialog(worker);
    if (this.workers.get(task.id) !== worker || task.state !== "needs_input") return;
    task.state = "running";
    task.question = undefined;
    this.log(task, reason);
    this.save(task);
  }

  private async onSettled(task: Task, worker: Worker): Promise<void> {
    if (checklistDone(task)) {
      if (task.pr === undefined) {
        const promptsSent = worker.promptsSent;
        const changed = await this.hasNetDiff(task);
        if (this.workers.get(task.id) !== worker || task.state !== "running" || worker.promptsSent !== promptsSent) return;
        if (!changed) return this.stop(task, worker, "done", worker.lastText);
      }
      const prStage = !task.manualReview || task.phase === "pr" || task.pr !== undefined;
      if (!prStage) return this.stop(task, worker, "review");
      const promptsSent = worker.promptsSent;
      const pr = (await findPr(task)) ?? prFromText(worker.lastText);
      const stale = worker.promptsSent !== promptsSent || !checklistDone(task);
      if (this.workers.get(task.id) !== worker || task.state !== "running" || stale) return;
      if (pr !== undefined) {
        task.pr = pr;
        return this.stop(task, worker, "pr_open");
      }
    }
    if (!worker.nudged) {
      worker.nudged = true;
      this.prompt(task, worker, NUDGE_PROMPT);
      return;
    }
    task.state = "needs_input";
    task.question = `The worker stopped before finishing.${worker.lastText ? `\n${worker.lastText}` : ""}`;
    this.save(task);
  }

  /** Finish the task in `state`; a `summary` marks it `done` with the `no_change` outcome. */
  private stop(task: Task, worker: Worker, state: "review" | "pr_open" | "done", summary?: string): void {
    task.state = state;
    task.outcome = state === "done" ? "no_change" : undefined;
    task.summary = state === "done" ? summary : undefined;
    this.log(task, `state: ${state}${task.outcome ? ` (${task.outcome})` : ""}`);
    this.workers.delete(task.id);
    task.pid = undefined;
    this.save(task);
    worker.child.stdin?.end();
    this.awaitExit(task.id, worker.child, FINISH_GRACE_MS);
    this.pump();
  }

  private fail(task: Task, error: string): void {
    task.state = "failed";
    task.error = error;
    task.question = undefined;
    this.log(task, `failed: ${error}`);
    this.stopWorker(task);
    this.save(task);
    this.pump();
  }

  /** Kill the task's worker (if any) and drop its pending resume prompt; the task's state is the caller's to set. */
  private stopWorker(task: Task): void {
    this.resumePrompts.delete(task.id);
    const worker = this.workers.get(task.id);
    if (worker) {
      this.workers.delete(task.id);
      clearDialog(worker);
      worker.child.kill();
      this.awaitExit(task.id, worker.child, KILL_GRACE_MS);
    }
    task.pid = undefined;
  }

  /** Keep the task's session busy until `child` exits, SIGKILLing it after `graceMs`. */
  private awaitExit(taskId: string, child: ChildProcess, graceMs: number): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.exiting.set(taskId, child);
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs).unref();
    child.once("exit", () => {
      clearTimeout(timer);
      if (this.exiting.get(taskId) === child) this.exiting.delete(taskId);
      this.pump();
    });
  }

  private async hasNetDiff(task: Task): Promise<boolean> {
    const { stdout } = await promisify(execFile)("git", ["diff", "--name-only", `${this.baseSha()}...HEAD`], { cwd: task.worktree, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim() !== "";
  }

  private baseSha(): string {
    return git(this.opts.repoRoot, "rev-parse", this.opts.config.baseRef).trim();
  }

  private save(task: Task): void {
    task.updatedAt = new Date().toISOString();
    this.tasks.set(task.id, task);
    this.opts.db
      .prepare(
        "INSERT INTO tasks (id, node, state, data, updated_at, project) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at",
      )
      .run(task.id, task.node, task.state, JSON.stringify(task), task.updatedAt, task.project);
    this.opts.onEvent?.({ type: "task", task });
  }

  private chatEntry(task: Task, role: ChatEntry["role"], text: string): void {
    const entry: ChatEntry = { role, text, at: new Date().toISOString() };
    mkdirSync(dirname(this.chatPath(task)), { recursive: true });
    appendFileSync(this.chatPath(task), JSON.stringify(entry) + "\n");
    this.opts.onEvent?.({ type: "chat", taskId: task.id, entry });
  }

  private log(task: Task, text: string): void {
    const time = new Date().toISOString().slice(11, 19);
    const lines = text.split("\n").map((l) => `${time} ${l}`);
    mkdirSync(dirname(task.logPath!), { recursive: true });
    appendFileSync(task.logPath!, lines.join("\n") + "\n");
    for (const line of lines) this.opts.onEvent?.({ type: "log", taskId: task.id, line });
  }
}

function checklistDone(task: Task): boolean {
  return task.checklist.length > 0 && task.checklist.every((item) => item.done);
}

function defaultPrompt(title: string, req: StartTaskRequest): string {
  const where = req.node ? `in \`${req.node}\`` : "at the repository root";
  const findings = req.findingIds.length ? ` Address techtree findings: ${req.findingIds.join(", ")}.` : "";
  return `${title} ${where}.${findings}`;
}

function finishRule(task: Task): string {
  return task.manualReview
    ? "Manual review is on: when the checklist is done, commit on the current branch and stop. Do not push or open a PR."
    : "When the checklist is done, commit, push the branch to the upstream remote and open a PR with gh, " +
        "following the repository's PR template. Never merge.";
}

function openPrPrompt(task: Task): string {
  return (
    `The change was reviewed and approved. Push branch ${task.branch} to the upstream remote and open a pull request ` +
    "with gh, following the repository's PR template. Never merge. Call techtree_report {phase: \"pr\"} first."
  );
}

/** PR number from a `…/pull/<n>` URL in the worker's last message, used when `gh` lookups fail. */
export function prFromText(text: string | undefined): number | undefined {
  const matches = [...(text ?? "").matchAll(/https:\/\/\S+?\/pull\/(\d+)/g)];
  return matches.length ? Number(matches[matches.length - 1][1]) : undefined;
}

async function findPr(task: Task): Promise<number | undefined> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["pr", "view", String(task.pr ?? task.branch), "--json", "number", "--jq", ".number"], {
      cwd: task.worktree,
      timeout: PR_LOOKUP_TIMEOUT_MS,
    });
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function clearDialog(worker: Worker): void {
  clearTimeout(worker.dialog?.timer);
  worker.dialog = undefined;
}

function dialogResponse(dialog: Dialog, text: string): object {
  if (dialog.method === "confirm")
    return { type: "extension_ui_response", id: dialog.id, confirmed: /^\s*(y|yes|ok|true|allow)\b/i.test(text) };
  return { type: "extension_ui_response", id: dialog.id, value: text };
}

function send(worker: Worker, record: object): void {
  worker.child.stdin?.write(JSON.stringify(record) + "\n");
}

/** Strict LF framing as rpc.md requires (readline would also split on U+2028/U+2029). */
function splitLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** `git`, ignoring failure (e.g. the worktree or branch is already gone). */
function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // already gone
  }
}

/** Kill a previous server's worker, checking its command line so a reused pid is left alone. */
function killOrphanedWorker(pid: number, taskId: string): void {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (command.includes(`--session-id ${taskId}`)) process.kill(pid);
  } catch {
    // ps exits non-zero when the process is already gone
  }
}

function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
