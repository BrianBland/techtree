import type { StartTask } from "../runner/runner.ts";
import type { Cache, PrState, Task, TaskState } from "../types.ts";
import type { PrPoller } from "./poller.ts";

/** The part of the task runner babysit drives; `TaskRunner` implements it. */
export interface BabysitRunner {
  get(taskId: string): Task | undefined;
  start(req: StartTask): Task;
  resumeTask(taskId: string, prompt: string): Task;
  cancel(taskId: string): Task;
}

export interface BabysitterOptions {
  poller: PrPoller;
  runner: BabysitRunner;
  /** Holds the auto-babysit setting. */
  cache: Cache;
}

const MAX_FIX_ATTEMPTS = 3;
const LIVE_STATES: TaskState[] = ["queued", "running", "needs_input"];
const AUTO_BABYSIT = ["settings", "autoBabysit"] as const;

/**
 * Reacts to PR events on babysat PRs by resuming or starting a `techtree-babysit` agent.
 * Wire `onUpdate` and `onRemove` to the poller's options of the same names. See docs/DESIGN.md "PRs".
 */
export class Babysitter {
  private readonly opts: BabysitterOptions;

  constructor(opts: BabysitterOptions) {
    this.opts = opts;
  }

  /**
   * Toggle babysitting; switching on resets the fix attempts, re-checks the current gh user
   * and acts on the PR's current state.
   */
  async setBabysit(number: number, on: boolean): Promise<PrState> {
    const { poller } = this.opts;
    if (!on) return poller.update(number, { babysit: false });
    await poller.refreshUser();
    return this.switchOn(number);
  }

  /** Whether the current user's PRs start babysat (DESIGN "PRs", Auto-babysit). */
  get autoBabysit(): boolean {
    return this.opts.cache.get(...AUTO_BABYSIT) === true;
  }

  /**
   * Switching on babysits every open PR of the current gh user, and rejects (leaving the setting off)
   * when that user cannot be looked up; switching off changes no PR.
   */
  async setAutoBabysit(on: boolean): Promise<void> {
    if (!on) return this.opts.cache.set(...AUTO_BABYSIT, false);
    const { poller } = this.opts;
    const user = await poller.refreshUser();
    if (!user) throw new Error("gh user lookup failed; auto-babysit stays off");
    this.opts.cache.set(...AUTO_BABYSIT, true);
    for (const pr of poller.list()) if (pr.author === user && !pr.babysit) this.switchOn(pr.number);
  }

  private switchOn(number: number): PrState {
    const pr = this.opts.poller.update(number, { babysit: true }, 0);
    this.onUpdate(undefined, pr);
    return pr;
  }

  /** A merged or closed PR: stop the fix running for it. */
  onRemove(pr: PrState): void {
    if (pr.babysit) this.stopFix(pr);
  }

  onUpdate(prev: PrState | undefined, next: PrState): void {
    const { poller, runner } = this.opts;
    const firstSeenOwn = !prev && !next.babysit && poller.user !== undefined && next.author === poller.user;
    if (firstSeenOwn && this.autoBabysit) next = poller.update(next.number, { babysit: true }, 0);
    if (!next.babysit) return;
    const report = (patch: Partial<PrState>, fixAttempts?: number) => poller.update(next.number, patch, fixAttempts);
    if (next.ci === "pass" && next.review === "APPROVED" && next.mergeable === "MERGEABLE") {
      this.stopFix(next);
      return void report({ babysit: false, babysitStatus: "ready to merge" }, 0);
    }
    const healthy = next.ci === "pass" && next.mergeable !== "CONFLICTING" && next.review !== "CHANGES_REQUESTED";
    if (healthy && poller.fixAttempts(next.number) > 0) report({}, 0);
    const triggers = triggersOf(prev, next).join(", ");
    // The hard observe-only rule: an agent could push or reply, so none runs on someone else's PR.
    if (!poller.user || next.author !== poller.user) {
      if (triggers) report({ babysitStatus: `observe-only: ${triggers}` });
      else if (!next.babysitStatus?.startsWith("observe-only")) report({ babysitStatus: "observe-only: not your PR" });
      return;
    }
    if (!triggers) return;
    const attempts = poller.fixAttempts(next.number);
    if (attempts >= MAX_FIX_ATTEMPTS)
      return void report({ babysit: false, babysitStatus: `gave up after ${MAX_FIX_ATTEMPTS} fix attempts` });
    const task = next.taskId ? runner.get(next.taskId) : undefined;
    if (task && LIVE_STATES.includes(task.state)) return void report({ babysitStatus: `fix in progress: ${triggers}` });

    const prompt = babysitPrompt(next, triggers);
    const taskId =
      task?.state === "pr_open" && task.worktree
        ? runner.resumeTask(task.id, prompt).id
        : runner.start({
            node: next.node,
            findingIds: [],
            title: `Babysit PR #${next.number}`,
            prompt,
            manualReview: false,
            plannedFrom: 0,
            plannedTo: 0,
            pr: next.number,
          }).id;
    report({ taskId, babysitStatus: `fix attempt ${attempts + 1}/${MAX_FIX_ATTEMPTS}: ${triggers}` }, attempts + 1);
  }

  private liveTask(pr: PrState): Task | undefined {
    const task = pr.taskId ? this.opts.runner.get(pr.taskId) : undefined;
    return task && LIVE_STATES.includes(task.state) ? task : undefined;
  }

  private stopFix(pr: PrState): void {
    const task = this.liveTask(pr);
    if (task) this.opts.runner.cancel(task.id);
  }
}

/** Events since `prev`; without `prev` (babysit just switched on), the failing conditions as they are now. */
function triggersOf(prev: PrState | undefined, next: PrState): string[] {
  const triggers: string[] = [];
  if (next.ci === "fail" && prev?.ci !== "fail") triggers.push("CI failing");
  if (next.review === "CHANGES_REQUESTED" && prev?.review !== "CHANGES_REQUESTED") triggers.push("changes requested");
  if (prev && (next.reviewCount ?? 0) > (prev.reviewCount ?? 0)) triggers.push("new review");
  if (next.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") triggers.push("merge conflict");
  return triggers;
}

function babysitPrompt(pr: PrState, triggers: string): string {
  return (
    `/skill:techtree-babysit PR #${pr.number} (${pr.url}) "${pr.title}" on head branch ${pr.branch} ` +
    `needs attention: ${triggers}.`
  );
}
