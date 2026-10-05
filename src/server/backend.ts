import type {
  ApiModels,
  ApiNode,
  ApiOverview,
  ApiSource,
  ApiState,
  ChatEntry,
  NodeId,
  PrState,
  ServerEvent,
  StartTaskRequest,
  Task,
  TaskPhase,
  TerminalMode,
} from "../types.ts";

/** Worker progress sent through `techtree_report`; exactly one field is expected per call. */
export interface WorkerReport {
  plan?: string[];
  phase?: TaskPhase;
  done?: number;
  needs_input?: string;
}

/**
 * Everything the HTTP API can do, one method per route (see docs/DESIGN.md, "HTTP API").
 * Methods throw `HttpError` for client errors (unknown id → 404, wrong task state → 409).
 */
export interface Backend {
  getState(): Promise<ApiState>;
  getNode(id: NodeId): Promise<ApiNode>;
  getOverview(): Promise<ApiOverview>;
  taskLog(taskId: string, tail: number): Promise<string>;
  taskDiff(taskId: string): Promise<string>;
  /** Lines around `line` of repo file `path` at the scored commit. */
  source(path: string, line?: number): Promise<ApiSource>;
  models(): Promise<ApiModels>;
  startTask(req: StartTaskRequest): Promise<Task>;
  answer(taskId: string, text: string): Promise<Task>;
  openPr(taskId: string): Promise<Task>;
  cancel(taskId: string): Promise<Task>;
  /** Message the task's agent; routed by task state (steer, answer or resume). */
  message(taskId: string, text: string): Promise<Task>;
  chat(taskId: string): Promise<ChatEntry[]>;
  /** Open a terminal window in the task's worktree (a shell, or interactive pi on its session). */
  openTerminal(taskId: string, mode: TerminalMode): Promise<void>;
  /** Stop and delete a task, its worktree and local branch (not for `pr_open`). */
  discard(taskId: string): Promise<void>;
  report(taskId: string, report: WorkerReport): Promise<Task>;
  setBabysit(prNumber: number, on: boolean): Promise<PrState>;
  rescore(): Promise<void>;
  scan(node: NodeId): Promise<void>;
  /** Register a listener for live events; returns the unsubscribe function. */
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
