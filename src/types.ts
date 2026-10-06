// Shared contracts for every techtree subsystem. See docs/DESIGN.md ("Data model").

export type NodeId = string; // repo-relative dir path, "" = root

export interface TreeNode {
  id: NodeId;
  name: string;
  kind: string; // "dir" | "crate" | ...
  parent: NodeId | null;
  children: NodeId[];
  files: string[]; // repo-relative paths of files directly in this dir
}

export interface Tree {
  repoRoot: string;
  nodes: Record<NodeId, TreeNode>;
}

export type Direction = "higher_better" | "lower_better" | "neutral";
export type Aggregate = "sum" | "max" | "mean_by_loc";

export interface MetricDef {
  key: string;
  label: string;
  unit?: string;
  direction: Direction; // neutral = weight-only (e.g. loc)
  aggregate: Aggregate; // how parents combine children
  normalizeBy?: string; // e.g. lint_warnings per "loc" before percentile
}

export type MetricValues = Record<NodeId, Record<string, number>>;

export interface Cache {
  get<T>(kind: string, key: string): T | undefined;
  set(kind: string, key: string, value: unknown): void;
}

export interface CollectCtx {
  repoRoot: string;
  tree: Tree;
  config: Config;
  cache: Cache;
  log(msg: string): void;
  signal?: AbortSignal;
}

export interface MetricPlugin {
  id: string;
  metrics: MetricDef[];
  /** Rename or re-kind nodes, e.g. Cargo crate roots become kind "crate". */
  annotate?(tree: Tree): void | Promise<void>;
  /** Own (non-aggregated) values per node. */
  collect(ctx: CollectCtx): Promise<MetricValues>;
  findings?(ctx: CollectCtx): Promise<Finding[]>;
}

export type Severity = "low" | "medium" | "high";
export type Effort = "trivial" | "small" | "medium" | "large";

export interface Finding {
  id: string; // stable hash of (source, file, rule, snippet)
  node: NodeId;
  file?: string;
  line?: number;
  source: string; // "clippy", "llm-scan", "test-gap", ...
  title: string;
  detail: string;
  severity: Severity;
  effort: Effort;
  metricEffects: Record<string, number>; // e.g. { lint_warnings: -1 } if fixed
  tags?: string[]; // "concurrency" | "security" | "api" | ... (complexity heuristic)
  confidence?: number; // 0..1, default 1: how likely the finding is a real problem (scales priority)
}

export type TaskState = "queued" | "running" | "needs_input" | "review" | "staged" | "pr_open" | "done" | "failed";
export type TaskPhase = "plan" | "explore" | "edit" | "test" | "pr";
/** `change` makes a branch and a PR; `scorer` proposes a project scorer; `plan` reports work items (DESIGN "Task kinds"). */
export type TaskKind = "change" | "scorer" | "plan";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  project: string; // Project.id
  kind?: TaskKind; // default "change"
  node: NodeId;
  title: string;
  prompt: string;
  findingIds: string[];
  state: TaskState;
  manualReview: boolean;
  model?: string;
  worktree?: string;
  branch?: string;
  pr?: number;
  plannedFrom: number; // composite scores
  plannedTo: number;
  checklist: ChecklistItem[];
  phase: TaskPhase;
  proposal?: ScorerSpec; // a scorer task's proposed scorer
  question?: string; // set while state === "needs_input"
  error?: string;
  pid?: number;
  logPath?: string;
  stagedAt?: string; // set while state === "staged" (DESIGN "Staging and combined PRs")
  bundle?: string; // Bundle.id once opened in a combined PR
  outcome?: "no_change"; // with state "done": the agent finished without a net diff
  summary?: string; // the agent's explanation for a no_change outcome
  proposedDismiss?: { findingIds: string[]; reason?: string }; // agent-proposed dismissal, awaiting the user
  createdAt: string;
  updatedAt: string;
}

export type CiState = "pass" | "fail" | "pending";

export interface PrState {
  number: number;
  url: string;
  title: string;
  author: string;
  node: NodeId;
  files: string[];
  ci: CiState;
  review: string; // gh reviewDecision, e.g. "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | ""
  updatedAt: string;
  babysit: boolean;
  stale: boolean; // no update in 3 days
  stuck: boolean; // no progress in 24h
  taskId?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  branch?: string; // head ref
  head?: string; // head commit sha
  reviewCount?: number; // submitted reviews by others that are not approvals
  babysitStatus?: string; // last babysit outcome, e.g. "observe-only: CI failing"
  project?: string; // its task's project, else "quality"; set on listed PRs and `pr` events
}

/** A combined PR opened from staged tasks (DESIGN "Staging and combined PRs"). */
export interface Bundle {
  id: string;
  project: string;
  title: string;
  branch: string;
  worktree: string;
  taskIds: string[]; // in staging order
  pr: number;
  url: string;
  createdAt: string;
}

// ---- Projects (DESIGN "Projects") ----

/** How a project is scored (DESIGN "Project scorers"). */
export interface ScorerSpec {
  plugins?: string[]; // metric plugin ids
  rubric?: string;
  command?: string[];
  plan?: boolean;
}

export interface Project {
  id: string;
  name: string;
  goal?: string;
  scorer: ScorerSpec;
  createdAt: string;
  builtin?: boolean;
}

// ---- Scoring output ----

export interface MetricScore {
  raw: number; // aggregated value
  value: number; // raw after normalizeBy (what the percentile ranks)
  pct: number | null; // 0..100, direction-adjusted (100 = best); null for neutral metrics
}

export interface NodeScore {
  node: NodeId;
  quality: number | null; // 0..100 composite
  metrics: Record<string, MetricScore>;
}

export interface Impact {
  node: number; // Δquality at the finding's node
  root: number; // Δquality at the root
}

/** A slice of a repo file at the scored commit, for previews. */
export interface ApiSource {
  path: string;
  startLine: number; // 1-based line number of lines[0]
  lines: string[];
}

export interface ScoreResult {
  sha: string;
  createdAt: string;
  tree: Tree;
  metricDefs: MetricDef[];
  own: MetricValues; // plugin output before aggregation
  scores: Record<NodeId, NodeScore>;
  findings: Finding[];
  impacts: Record<string, Impact>; // by finding id
}

export interface Suggestion {
  node: NodeId;
  title: string;
  source?: string; // the findings' source; suggestion lists are diversified by it
  project?: string; // set in the cross-project overview
  findingIds: string[];
  impact: Impact;
  effort: Effort;
  conflict: number; // 0..1
  priority: number;
  manualReview: boolean; // complexity-heuristic default
}

// ---- Config (.techtree.yaml) ----

export interface Config {
  weights: Record<string, number>; // metric key → weight in the composite
  minLoc: number; // nodes below this inherit their parent's percentile
  workers: number;
  worktreeTemplate: string; // "{home}", "{repo}", "{task}" placeholders
  baseRef: string; // ref new task worktrees branch from
  piCommand: string[]; // argv prefix used to spawn pi children, e.g. ["pi"]
  piLoadsExtension?: boolean; // pi already loads techtree's extension (installed in its extensions dir): don't pass `-e`
  defaultModel?: string; // start-dialog prefill, "provider/id"
  titleModel?: string; // combined PR titles, "provider/id"; unset = defaultModel
  refineModel?: string;
  pruneOnIdle?: string[]; // worktree-relative paths deleted when a worker run ends
 // "Refine with agent" model, "provider/id"; unset = defaultModel
  openBrowser?: boolean; // /techtree opens the UI in the default browser (default true)
  terminal?: string[]; // "Open in terminal" argv template with {cwd} and {command}; unset = platform default
  ignore: string[]; // path prefixes or globs excluded from the tree
  plugins: Record<string, Record<string, unknown>>; // per-plugin options
}

// ---- HTTP API (server ↔ web UI) ----

export interface ApiState {
  repo: { root: string; id: string; name: string };
  project: Project;
  snapshot: { sha: string; createdAt: string } | null;
  tree: Tree;
  metricDefs: MetricDef[];
  weights: Record<string, number>;
  scores: Record<NodeId, NodeScore>;
  tasks: Task[];
  prs: PrState[];
  findingCounts: Record<NodeId, number>; // own findings per node
  suggestionCounts: Record<NodeId, number>; // currently offered suggestions per node
}

export interface HistoryPoint {
  sha: string;
  createdAt: string;
  quality: number | null;
  metrics: Record<string, number | null>; // pct per metric
}

export interface ApiNode {
  score: NodeScore;
  history: HistoryPoint[];
  findings: (Finding & { impact: Impact })[]; // ranked by impact.node desc
  prs: PrState[];
  tasks: Task[];
  suggestions: Suggestion[];
  dismissed: (Finding & { reason?: string })[]; // the node's dismissed findings (DESIGN "Dismissed findings")
  ownCtas: Cta[]; // calls to action anchored at this node, ranked
  childCtas: Cta[]; // top calls to action from descendants (not this node), ranked, at most 10
}

/** A call to action: something the user should do, ranked for the node panel and overview. */
export interface Cta {
  kind: "task" | "pr" | "suggestion";
  node: NodeId;
  rank: number; // higher first; see DESIGN "Calls to action"
  reason: string; // short label, e.g. "needs input", "CI failing", "+6.2 quality"
  task?: Task;
  pr?: PrState;
  suggestion?: Suggestion;
}

export interface ApiOverview {
  attentionTasks: Task[]; // needs_input or review
  stagedTasks: Task[]; // staged, in staging order
  activeTasks: Task[]; // queued or running, any kind
  flaggedPrs: PrState[]; // failing, stuck or stale
  suggestions: Suggestion[];
  coverage: { scannedNodes: number; totalNodes: number; scannedLoc: number; totalLoc: number };
  scorerErrors?: string[]; // failures of the project's scorer in its latest run
}

/** `GET /api/prs`: the outbox (DESIGN "Outbox"). */
export interface ApiPrs {
  prs: PrState[]; // every open PR of every project, each with its `project`
  tasks: Task[]; // the PRs' linked tasks (`PrState.taskId`)
  autoBabysit: boolean;
}

export interface StartTaskRequest {
  node: NodeId;
  findingIds: string[];
  title?: string;
  prompt?: string;
  manualReview: boolean;
  model?: string; // "provider/id"; omitted = pi's default
  project?: string; // default "quality"
  kind?: TaskKind; // default "change"
}

export interface ApiModels {
  default: string | null; // prefill for the start dialog
  models: string[]; // "provider/id"
}

/** One turn of a task's conversation with its agent, for the chat pane. */
export interface ChatEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  at: string; // ISO timestamp
}

/** "Open in terminal": a shell in the worktree, or interactive pi on the task's session. */
export type TerminalMode = "shell" | "agent";

export type ServerEvent =
  | { type: "task"; task: Task }
  | { type: "pr"; pr: PrState }
  | { type: "pr_removed"; number: number } // merged or closed; drop it from the PR list
  | { type: "task_removed"; taskId: string } // discarded
  | { type: "log"; taskId: string; line: string }
  | { type: "chat"; taskId: string; entry: ChatEntry }
  | { type: "scores"; snapshot: { sha: string; createdAt: string } }
  | { type: "scan"; node: NodeId; status: "running" | "done" | "failed"; message?: string };
