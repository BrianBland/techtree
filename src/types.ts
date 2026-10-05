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
}

export type TaskState = "queued" | "running" | "needs_input" | "review" | "pr_open" | "done" | "failed";
export type TaskPhase = "plan" | "explore" | "edit" | "test" | "pr";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  node: NodeId;
  title: string;
  prompt: string;
  findingIds: string[];
  state: TaskState;
  manualReview: boolean;
  worktree?: string;
  branch?: string;
  pr?: number;
  plannedFrom: number; // composite scores
  plannedTo: number;
  checklist: ChecklistItem[];
  phase: TaskPhase;
  question?: string; // set while state === "needs_input"
  error?: string;
  pid?: number;
  logPath?: string;
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
}

// ---- Scoring output ----

export interface MetricScore {
  raw: number; // aggregated value
  value: number; // raw after normalizeBy (what the percentile ranks)
  pct: number | null; // 0..100, direction-adjusted (100 = best); null for neutral metrics
  inherited?: boolean; // pct taken from the parent because the node is below minLoc
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
  ignore: string[]; // path prefixes or globs excluded from the tree
  plugins: Record<string, Record<string, unknown>>; // per-plugin options
}

// ---- HTTP API (server ↔ web UI) ----

export interface ApiState {
  repo: { root: string; id: string; name: string };
  snapshot: { sha: string; createdAt: string } | null;
  tree: Tree;
  metricDefs: MetricDef[];
  weights: Record<string, number>;
  scores: Record<NodeId, NodeScore>;
  tasks: Task[];
  prs: PrState[];
  findingCounts: Record<NodeId, number>; // own findings per node
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
}

export interface ApiOverview {
  attentionTasks: Task[]; // needs_input or review
  flaggedPrs: PrState[]; // failing, stuck or stale
  suggestions: Suggestion[];
  coverage: { scannedNodes: number; totalNodes: number; scannedLoc: number; totalLoc: number };
}

export interface StartTaskRequest {
  node: NodeId;
  findingIds: string[];
  title?: string;
  prompt?: string;
  manualReview: boolean;
}

export type ServerEvent =
  | { type: "task"; task: Task }
  | { type: "pr"; pr: PrState }
  | { type: "log"; taskId: string; line: string }
  | { type: "scores"; snapshot: { sha: string; createdAt: string } }
  | { type: "scan"; node: NodeId; status: "running" | "done" | "failed"; message?: string };
