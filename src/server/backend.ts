import type {
  ApiModels,
  ApiNode,
  ApiOverview,
  ApiSource,
  ApiState,
  ChatEntry,
  NodeId,
  PrState,
  Project,
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

export interface ProjectInput {
  name?: string;
  goal?: string;
}

/**
 * Everything the HTTP API can do, one method per route (see docs/DESIGN.md, "HTTP API").
 * Methods throw `HttpError` for client errors (unknown id → 404, wrong task state → 409).
 * A `project` argument defaults to "quality" (DESIGN "Projects").
 */
export interface Backend {
  listProjects(): Promise<Project[]>;
  createProject(input: ProjectInput): Promise<Project>;
  updateProject(id: string, input: ProjectInput): Promise<Project>;
  /** Delete a custom project, discarding its tasks and deleting its rows. */
  deleteProject(id: string): Promise<void>;
  getState(project?: string): Promise<ApiState>;
  getNode(id: NodeId, project?: string): Promise<ApiNode>;
  /** `project` "all" gives the cross-project overview. */
  getOverview(project?: string): Promise<ApiOverview>;
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
  rescore(project?: string): Promise<void>;
  scan(node: NodeId, project?: string): Promise<void>;
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
