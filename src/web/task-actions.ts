import type { Task, TaskState } from "../types.ts";

const LIVE_STATES: TaskState[] = ["queued", "running", "needs_input"];

/** Whether a worker owns (or is about to own) the task's pi session. */
export function hasLiveWorker(task: Task): boolean {
  return LIVE_STATES.includes(task.state);
}

/** Why the server would refuse a chat message to the task now, or undefined when it accepts one. */
export function messageBlocked(task: Task): string | undefined {
  if (task.state === "queued") return "waiting for a worker slot";
  if (task.state === "running" && task.pid === undefined) return "starting";
  if (task.state === "done" && task.outcome !== "no_change") return "the task is done";
  return undefined;
}
