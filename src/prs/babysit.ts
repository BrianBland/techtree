import type { StartTask } from "../runner/runner.ts";
import type { PrState, Task, TaskState } from "../types.ts";
import type { PrPoller } from "./poller.ts";

/** The part of the task runner babysit drives; `TaskRunner` implements it. */
export interface BabysitRunner {
  get(taskId: string): Task | undefined;
  start(req: StartTask): Task;
  resumeTask(taskId: string, prompt: string): Task;
}

export interface BabysitterOptions {
  poller: PrPoller;
  runner: BabysitRunner;
}

const MAX_FIX_ATTEMPTS = 3;
const LIVE_STATES: TaskState[] = ["queued", "running", "needs_input"];

/**
 * Reacts to PR events on babysat PRs by resuming or starting a `techtree-babysit` agent.
 * Wire `onUpdate` to the poller's `onUpdate` option. See docs/DESIGN.md "PRs".
 */
export class Babysitter {
  private readonly opts: BabysitterOptions;

  constructor(opts: BabysitterOptions) {
    this.opts = opts;
  }

  /** Toggle babysitting; switching on resets the fix attempts and acts on the PR's current state. */
  setBabysit(number: number, on: boolean): PrState {
    const { poller } = this.opts;
    if (!on) return poller.update(number, { babysit: false });
    const pr = poller.update(number, { babysit: true }, 0);
    this.onUpdate(undefined, pr);
    return pr;
  }

  onUpdate(prev: PrState | undefined, next: PrState): void {
    if (!next.babysit) return;
    const { poller, runner } = this.opts;
    const report = (patch: Partial<PrState>, fixAttempts?: number) => poller.update(next.number, patch, fixAttempts);
    if (next.ci === "pass" && next.review === "APPROVED" && next.mergeable === "MERGEABLE")
      return void report({ babysit: false, babysitStatus: "ready to merge" });
    const triggers = triggersOf(prev, next).join(", ");
    if (!triggers) return;
    // The hard observe-only rule: an agent could push or reply, so none runs on someone else's PR.
    if (!poller.user || next.author !== poller.user) return void report({ babysitStatus: `observe-only: ${triggers}` });
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
