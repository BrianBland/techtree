import { nodeCtas, rankCtas } from "../core/cta.ts";
import { DEFAULT_WEIGHTS } from "../config.ts";
import type {
  ApiNode,
  ApiOverview,
  ApiState,
  Effort,
  Finding,
  HistoryPoint,
  Impact,
  MetricDef,
  NodeId,
  NodeScore,
  PrState,
  ServerEvent,
  Severity,
  StartTaskRequest,
  Suggestion,
  Task,
  TaskPhase,
  TaskState,
  Tree,
  TreeNode,
} from "../types.ts";
import { HttpError, type Backend, type WorkerReport } from "./backend.ts";

export interface MockBackend extends Backend {
  /** Advance running tasks and pending scans by one step. */
  tick(): void;
  stop(): void;
}

export interface MockOptions {
  seed?: number;
  /** Interval between automatic ticks; 0 disables the timer (tests call `tick()`). */
  tickMs?: number;
}

const METRICS: MetricDef[] = [
  { key: "loc", label: "Lines of code", direction: "neutral", aggregate: "sum" },
  { key: "files", label: "Files", direction: "neutral", aggregate: "sum" },
  { key: "test_count", label: "Tests", direction: "higher_better", aggregate: "sum" },
  { key: "test_ratio", label: "Test ratio", direction: "higher_better", aggregate: "mean_by_loc" },
  { key: "test_time", label: "Test time", unit: "s", direction: "neutral", aggregate: "sum" },
  { key: "lint_warnings", label: "Lint warnings", unit: "/kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
  { key: "unwrap_density", label: "Unwrap density", direction: "lower_better", aggregate: "mean_by_loc" },
  { key: "complexity", label: "Complexity", direction: "lower_better", aggregate: "mean_by_loc" },
  { key: "todo_density", label: "TODO density", direction: "lower_better", aggregate: "mean_by_loc" },
  { key: "max_file_loc", label: "Largest file", unit: "lines", direction: "lower_better", aggregate: "max" },
  { key: "churn_90d", label: "Churn (90d)", direction: "neutral", aggregate: "sum" },
  { key: "review_debt", label: "Review debt", direction: "lower_better", aggregate: "mean_by_loc" },
];

const WORDS = (
  "core net rpc engine storage trie evm txpool consensus sync p2p db codec primitives node cli metrics " +
  "tracing utils config types builder payload exec state cache proof mempool handlers api server client " +
  "bench fixtures macros chain blocks receipts headers bodies peers session discovery stages pruner " +
  "snapshot static provider signer wallet keys crypto hash merkle bloom filter range batch stream codec2"
).split(" ");

const FINDING_KINDS: { source: string; title: string; effort: Effort; severity: Severity; metric: string; tags?: string[] }[] = [
  { source: "clippy", title: "needless clone in hot loop", effort: "trivial", severity: "low", metric: "lint_warnings" },
  { source: "clippy", title: "large enum variant", effort: "small", severity: "medium", metric: "lint_warnings" },
  { source: "test-gap", title: "public fn without tests", effort: "small", severity: "medium", metric: "test_ratio" },
  { source: "unwrap", title: "unwrap on fallible decode", effort: "small", severity: "high", metric: "unwrap_density", tags: ["security"] },
  { source: "generic", title: "file over 1500 lines", effort: "large", severity: "medium", metric: "max_file_loc" },
  { source: "generic", title: "TODO cluster", effort: "medium", severity: "low", metric: "todo_density" },
  { source: "llm-scan", title: "lock held across await", effort: "medium", severity: "high", metric: "review_debt", tags: ["concurrency"] },
  { source: "llm-scan", title: "public API leaks internal type", effort: "medium", severity: "medium", metric: "review_debt", tags: ["api"] },
];

const MIN_DIRS = 700;
const EFFORT_COST: Record<Effort, number> = { trivial: 1, small: 2, medium: 4, large: 8 };
const PHASES: TaskPhase[] = ["plan", "explore", "edit", "test", "pr"];
const PLAN = ["Read the module and its callers", "Write a failing test", "Apply the fix", "Run the crate tests", "Summarise the change"];
const LOG_LINES = [
  "reading src/lib.rs",
  "grep: 14 call sites",
  "cargo test -p {crate} ... ok",
  "editing {file}",
  "clippy clean",
  "thinking about error propagation",
  "running nextest (212 tests)",
];

/** Deterministic synthetic backend for UI development and tests. */
export function createMockBackend({ seed = 1, tickMs = 1500 }: MockOptions = {}): MockBackend {
  const rand = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const tree = buildTree(rand);
  const ids = Object.keys(tree.nodes);
  const scores = scoreTree(tree, rand);
  const findings = makeFindings(ids, rand);
  const listeners = new Set<(e: ServerEvent) => void>();
  const logs = new Map<string, string[]>();
  const pendingScans: NodeId[] = [];
  let snapshot = { sha: hex(rand, 40), createdAt: new Date().toISOString() };
  let nextTask = 1;
  let nextPr = 4100;

  const emit = (event: ServerEvent) => listeners.forEach((l) => l(event));
  const quality = (id: NodeId) => scores[id].quality ?? 50;
  const findingsOf = (id: NodeId) => findings.filter((f) => f.finding.node === id);
  const deepNodes = ids.filter((id) => id.split("/").length >= 4);

  function suggestionsFor(id: NodeId): Suggestion[] {
    const own = findingsOf(id);
    const single = own.map(({ finding, impact }) => suggestion(id, finding.title, [finding], [impact]));
    if (own.length > 1) {
      single.push(suggestion(id, `Fix ${own.length} findings in ${tree.nodes[id].name}`, own.map((f) => f.finding), own.map((f) => f.impact)));
    }
    return single.sort((a, b) => b.priority - a.priority);
  }

  function suggestion(id: NodeId, title: string, fs: Finding[], impacts: Impact[]): Suggestion {
    const impact = { node: sum(impacts.map((i) => i.node)), root: sum(impacts.map((i) => i.root)) };
    const effort = fs.map((f) => f.effort).sort((a, b) => EFFORT_COST[b] - EFFORT_COST[a])[0];
    const conflict = prs.some((p) => p.node === id) ? 0.5 : 0;
    return {
      node: id,
      title,
      findingIds: fs.map((f) => f.id),
      impact,
      effort,
      conflict,
      priority: round2((impact.node / EFFORT_COST[effort]) * (1 - conflict)),
      manualReview:
        EFFORT_COST[effort] >= EFFORT_COST.medium || fs.length > 1 || fs.some((f) => f.tags?.some((t) => ["concurrency", "security", "api"].includes(t))),
    };
  }

  function newTask(node: NodeId, title: string, findingIds: string[], state: TaskState, manualReview: boolean): Task {
    const planned = sum(findings.filter((f) => findingIds.includes(f.finding.id)).map((f) => f.impact.node));
    const now = new Date().toISOString();
    const task: Task = {
      id: `t${nextTask++}`,
      node,
      title,
      prompt: `${title}\n\nNode: ${node || "(root)"}`,
      findingIds,
      state,
      manualReview,
      plannedFrom: round2(quality(node)),
      plannedTo: round2(Math.min(100, quality(node) + Math.max(planned, 1))),
      checklist: [],
      phase: "plan",
      createdAt: now,
      updatedAt: now,
    };
    if (state !== "queued") {
      task.branch = `techtree-${task.id}`;
      task.worktree = `/tmp/worktrees/techtree-${task.id}`;
      task.checklist = PLAN.map((text) => ({ text, done: false }));
    }
    logs.set(task.id, [`task ${task.id} ${state}: ${title}`]);
    return task;
  }

  function newPr(node: NodeId, title: string, extra: Partial<PrState> = {}): PrState {
    const number = nextPr++;
    return {
      number,
      url: `https://example.invalid/pulls/${number}`,
      title,
      author: pick(["alice", "bob", "carol", "techtree"]),
      node,
      files: [`${node}/mod.rs`, `${node}/tests.rs`],
      ci: "pending",
      review: "REVIEW_REQUIRED",
      updatedAt: new Date().toISOString(),
      babysit: false,
      stale: false,
      stuck: false,
      ...extra,
    };
  }

  const prs: PrState[] = [];
  const hot = pick(deepNodes);
  prs.push(
    newPr(hot, "Reduce allocations in the decoder", { ci: "fail", babysit: true }),
    newPr(hot, "Split the session state machine", { ci: "pass", review: "APPROVED" }),
    newPr(pick(deepNodes), "Add proptests for range queries", { stuck: true, updatedAt: hoursAgo(30) }),
    newPr(pick(deepNodes), "Replace unwraps in header parsing", { stale: true, updatedAt: hoursAgo(24 * 5), review: "CHANGES_REQUESTED" }),
    newPr(pick(deepNodes), "Document the pruner config", { ci: "pass" }),
  );

  const tasks: Task[] = [];
  const seededStates: TaskState[] = ["running", "running", "queued", "needs_input", "review", "pr_open", "done", "failed"];
  const candidates = ids.filter((id) => findingsOf(id).length > 0);
  for (const state of seededStates) {
    const node = pick(candidates);
    const s = suggestionsFor(node)[0];
    const task = newTask(node, s.title, s.findingIds, state, s.manualReview);
    if (state === "running") task.checklist.forEach((item, i) => (item.done = i < 1 + Math.floor(rand() * 2)));
    if (state === "running") task.phase = "edit";
    if (["review", "pr_open", "done"].includes(state)) {
      task.checklist.forEach((item) => (item.done = true));
      task.phase = "pr";
    }
    if (state === "needs_input") {
      task.checklist[0].done = true;
      task.phase = "explore";
      task.question = "The decoder is also used by the light client. Should the fix keep the old error type for compatibility?";
    }
    if (state === "failed") task.error = "worker exited with code 1 (see log)";
    if (state === "pr_open") {
      const pr = newPr(node, task.title, { taskId: task.id, babysit: true, author: "techtree" });
      prs.push(pr);
      task.pr = pr.number;
    }
    tasks.push(task);
  }

  const taskById = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new HttpError(404, `no task ${id}`);
    return task;
  };
  const requireState = (task: Task, ...states: TaskState[]) => {
    if (!states.includes(task.state)) throw new HttpError(409, `task ${task.id} is ${task.state}`);
  };
  const touch = (task: Task) => {
    task.updatedAt = new Date().toISOString();
    emit({ type: "task", task: structuredClone(task) });
    return structuredClone(task);
  };
  const log = (task: Task, line: string) => {
    const lines = logs.get(task.id) ?? [];
    lines.push(line);
    logs.set(task.id, lines.slice(-1000));
    emit({ type: "log", taskId: task.id, line });
  };

  function openPrFor(task: Task) {
    const pr = newPr(task.node, task.title, { taskId: task.id, author: "techtree", babysit: true });
    prs.push(pr);
    task.pr = pr.number;
    task.state = "pr_open";
    emit({ type: "pr", pr: structuredClone(pr) });
  }

  function tick() {
    for (const task of tasks.filter((t) => t.state === "running")) {
      const next = task.checklist.find((item) => !item.done);
      const crate = task.node.split("/").slice(0, 3).join("/");
      log(task, pick(LOG_LINES).replace("{crate}", crate || "root").replace("{file}", `${task.node}/mod.rs`));
      if (next) {
        next.done = true;
        const doneCount = task.checklist.filter((c) => c.done).length;
        task.phase = PHASES[Math.min(PHASES.length - 1, doneCount)];
        log(task, `✓ ${next.text}`);
      } else if (task.manualReview) {
        task.state = "review";
      } else {
        openPrFor(task);
      }
      touch(task);
    }
    if (tasks.filter((t) => t.state === "running").length < 2) {
      const queued = tasks.find((t) => t.state === "queued");
      if (queued) {
        queued.state = "running";
        queued.checklist = PLAN.map((text) => ({ text, done: false }));
        touch(queued);
      }
      if (tasks.length < 40 && !tasks.some((t) => t.state === "queued")) {
        const node = pick(candidates);
        const s = suggestionsFor(node)[0];
        touch(pushTask(newTask(node, s.title, s.findingIds, "queued", s.manualReview)));
      }
    }
    for (const node of pendingScans.splice(0)) emit({ type: "scan", node, status: "done", message: "12 files scanned" });
  }

  function pushTask(task: Task) {
    tasks.push(task);
    return task;
  }

  const timer = tickMs > 0 ? setInterval(tick, tickMs) : undefined;
  timer?.unref();

  return {
    tick,
    stop: () => clearInterval(timer),

    async getState(): Promise<ApiState> {
      const findingCounts: Record<NodeId, number> = {};
      for (const { finding } of findings) findingCounts[finding.node] = (findingCounts[finding.node] ?? 0) + 1;
      return structuredClone({
        repo: { root: "/synthetic/base", id: "base-mock0000", name: "base" },
        snapshot,
        tree,
        metricDefs: METRICS,
        weights: DEFAULT_WEIGHTS,
        scores,
        tasks,
        prs,
        findingCounts,
      });
    },

    async getNode(id: NodeId): Promise<ApiNode> {
      if (!tree.nodes[id]) throw new HttpError(404, `no node ${JSON.stringify(id)}`);
      return structuredClone({
        score: scores[id],
        history: history(id, scores[id]),
        findings: findingsOf(id)
          .map(({ finding, impact }) => ({ ...finding, impact }))
          .sort((a, b) => b.impact.node - a.impact.node),
        prs: prs.filter((p) => p.node === id),
        tasks: tasks.filter((t) => t.node === id),
        suggestions: suggestionsFor(id),
        ...nodeCtas(id, rankCtas(tasks, prs, candidates.flatMap(suggestionsFor))),
      });
    },

    async getOverview(): Promise<ApiOverview> {
      const scanned = new Set(findings.filter((f) => f.finding.source === "llm-scan").map((f) => f.finding.node));
      return structuredClone({
        attentionTasks: tasks.filter((t) => t.state === "needs_input" || t.state === "review"),
        flaggedPrs: prs.filter((p) => p.ci === "fail" || p.stuck || p.stale),
        suggestions: candidates
          .flatMap(suggestionsFor)
          .sort((a, b) => b.priority - a.priority)
          .slice(0, 8),
        coverage: {
          scannedNodes: scanned.size,
          totalNodes: ids.length,
          scannedLoc: sum([...scanned].map((id) => scores[id].metrics.loc.raw)),
          totalLoc: scores[""].metrics.loc.raw,
        },
      });
    },

    async taskLog(id: string, tail: number) {
      const lines = logs.get(taskById(id).id) ?? [];
      return lines.slice(Math.max(0, lines.length - tail)).join("\n");
    },

    async taskDiff(id: string) {
      const task = taskById(id);
      const file = `${task.node}/mod.rs`;
      return [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -40,7 +40,9 @@ impl Decoder {",
        "     pub fn decode(&mut self, buf: &[u8]) -> Result<Frame, DecodeError> {",
        "-        let header = Header::parse(buf).unwrap();",
        "+        let header = Header::parse(buf)?;",
        "+        if header.len > self.max_len {",
        "+            return Err(DecodeError::TooLarge(header.len));",
        "+        }",
        "         self.frames.push(header);",
      ].join("\n");
    },

    async startTask(req: StartTaskRequest) {
      if (!tree.nodes[req.node]) throw new HttpError(404, `no node ${JSON.stringify(req.node)}`);
      const running = tasks.filter((t) => t.state === "running").length;
      const title = req.title ?? suggestionsFor(req.node).find((s) => s.findingIds.join() === req.findingIds.join())?.title ?? "Improve node";
      const task = pushTask(newTask(req.node, title, req.findingIds, running < 3 ? "running" : "queued", req.manualReview));
      if (req.prompt) task.prompt = req.prompt;
      return touch(task);
    },

    async answer(id: string, text: string) {
      const task = taskById(id);
      requireState(task, "needs_input");
      task.state = "running";
      delete task.question;
      log(task, `answer: ${text}`);
      return touch(task);
    },

    async openPr(id: string) {
      const task = taskById(id);
      requireState(task, "review");
      openPrFor(task);
      return touch(task);
    },

    async cancel(id: string) {
      const task = taskById(id);
      requireState(task, "queued", "running", "needs_input", "review");
      task.state = "failed";
      task.error = "cancelled";
      return touch(task);
    },

    async report(id: string, report: WorkerReport) {
      const task = taskById(id);
      if (report.plan) task.checklist = report.plan.map((text) => ({ text, done: false }));
      if (report.phase) task.phase = report.phase;
      if (report.done !== undefined && task.checklist[report.done]) task.checklist[report.done].done = true;
      if (report.needs_input) {
        task.state = "needs_input";
        task.question = report.needs_input;
      }
      return touch(task);
    },

    async setBabysit(number: number, on: boolean) {
      const pr = prs.find((p) => p.number === number);
      if (!pr) throw new HttpError(404, `no PR #${number}`);
      pr.babysit = on;
      emit({ type: "pr", pr: structuredClone(pr) });
      return structuredClone(pr);
    },

    async rescore() {
      snapshot = { sha: hex(rand, 40), createdAt: new Date().toISOString() };
      emit({ type: "scores", snapshot });
    },

    async scan(node: NodeId) {
      if (!tree.nodes[node]) throw new HttpError(404, `no node ${JSON.stringify(node)}`);
      pendingScans.push(node);
      emit({ type: "scan", node, status: "running" });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function buildTree(rand: () => number): Tree {
  const nodes: Record<NodeId, TreeNode> = {};
  const add = (parent: NodeId | null, name: string, kind = "dir"): NodeId => {
    const id = parent === null ? "" : parent === "" ? name : `${parent}/${name}`;
    const fileCount = 1 + Math.floor(rand() * 6);
    nodes[id] = {
      id,
      name,
      kind,
      parent,
      children: [],
      files: Array.from({ length: fileCount }, (_, i) => `${id ? id + "/" : ""}${i === 0 ? "mod" : WORDS[(i * 7) % WORDS.length]}.rs`),
    };
    if (parent !== null) nodes[parent].children.push(id);
    return id;
  };
  const uniqueNames = (count: number) => {
    const names = new Set<string>();
    while (names.size < count) names.add(WORDS[Math.floor(rand() * WORDS.length)]);
    return [...names];
  };
  const grow = (parent: NodeId, depth: number, maxDepth: number) => {
    if (depth >= maxDepth) return;
    const count = Math.floor(rand() * (depth < 6 ? 4.2 : 2.5));
    for (const name of uniqueNames(count)) grow(add(parent, name), depth + 1, maxDepth);
  };

  const root = add(null, "base");
  const crates = add(root, "crates");
  const groups = uniqueNames(9).map((group) => add(crates, group));
  while (Object.keys(nodes).length < MIN_DIRS) {
    const group = groups[Math.floor(rand() * groups.length)];
    const name = `${nodes[group].name}-${WORDS[Math.floor(rand() * WORDS.length)]}`;
    if (nodes[`${group}/${name}`]) continue;
    const crate = add(group, name, "crate");
    grow(add(crate, "src"), 4, 9);
    if (rand() < 0.6) add(crate, "tests");
    if (rand() < 0.3) add(crate, "benches");
  }
  for (const top of ["bin", "docs", "scripts", "etc"]) grow(add(root, top), 1, 4);
  return { repoRoot: "/synthetic/base", nodes };
}

function scoreTree(tree: Tree, rand: () => number): Record<NodeId, NodeScore> {
  const own: Record<NodeId, Record<string, number>> = {};
  for (const node of Object.values(tree.nodes)) {
    const loc = Math.round(node.files.length * (40 + rand() ** 2 * 900));
    const testRatio = rand() ** 1.5;
    own[node.id] = {
      loc,
      files: node.files.length,
      test_count: Math.round((loc / 60) * testRatio),
      test_ratio: testRatio,
      test_time: round2((loc / 1000) * testRatio * (0.5 + rand() * 4)),
      lint_warnings: Math.floor(rand() ** 3 * loc * 0.02),
      unwrap_density: round2(rand() ** 2 * 8),
      complexity: round2(2 + rand() ** 2 * 18),
      todo_density: round2(rand() ** 4 * 5),
      max_file_loc: Math.round(loc / node.files.length) * (1 + Math.floor(rand() * 2)),
      churn_90d: Math.floor(rand() ** 3 * 120),
      review_debt: round2(rand() ** 3 * 10),
    };
  }

  const raw: Record<NodeId, Record<string, number>> = {};
  const aggregate = (id: NodeId): Record<string, number> => {
    const children = tree.nodes[id].children.map(aggregate);
    const all = [own[id], ...children];
    const loc = sum(all.map((v) => v.loc));
    const values: Record<string, number> = {};
    for (const def of METRICS) {
      const xs = all.map((v) => v[def.key]);
      if (def.aggregate === "sum") values[def.key] = round2(sum(xs));
      else if (def.aggregate === "max") values[def.key] = Math.max(...xs);
      else values[def.key] = round2(sum(all.map((v) => v[def.key] * v.loc)) / loc);
    }
    raw[id] = values;
    return values;
  };
  aggregate("");

  const ids = Object.keys(tree.nodes);
  const scores: Record<NodeId, NodeScore> = {};
  for (const id of ids) scores[id] = { node: id, quality: null, metrics: {} };
  for (const def of METRICS) {
    const value = (id: NodeId) => (def.normalizeBy ? (raw[id][def.key] / raw[id][def.normalizeBy]) * 1000 : raw[id][def.key]);
    const ranked = [...ids].sort((a, b) => value(a) - value(b));
    ranked.forEach((id, rank) => {
      const pct = (rank / (ranked.length - 1)) * 100;
      scores[id].metrics[def.key] = {
        raw: raw[id][def.key],
        value: round2(value(id)),
        pct: def.direction === "neutral" ? null : round2(def.direction === "higher_better" ? pct : 100 - pct),
      };
    });
  }
  for (const id of ids) {
    let total = 0;
    let weight = 0;
    for (const [key, w] of Object.entries(DEFAULT_WEIGHTS)) {
      const pct = scores[id].metrics[key]?.pct;
      if (pct == null) continue;
      total += w * pct;
      weight += w;
    }
    scores[id].quality = weight ? round2(total / weight) : null;
  }
  return scores;
}

function makeFindings(ids: NodeId[], rand: () => number): { finding: Finding; impact: Impact }[] {
  const out: { finding: Finding; impact: Impact }[] = [];
  for (const id of ids) {
    if (rand() > 0.3) continue;
    const count = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const kind = FINDING_KINDS[Math.floor(rand() * FINDING_KINDS.length)];
      const line = 1 + Math.floor(rand() * 900);
      const file = `${id ? id + "/" : ""}mod.rs`;
      const node = round2(0.3 + rand() ** 2 * 7);
      out.push({
        finding: {
          id: `f-${out.length}`,
          node: id,
          file,
          line,
          source: kind.source,
          title: kind.title,
          detail: `${kind.title} at ${file}:${line}.`,
          severity: kind.severity,
          effort: kind.effort,
          metricEffects: { [kind.metric]: kind.metric === "test_ratio" ? 0.05 : -1 },
          ...(kind.tags ? { tags: kind.tags } : {}),
        },
        impact: { node, root: round2(node / 25) },
      });
    }
  }
  return out;
}

function history(id: NodeId, score: NodeScore): HistoryPoint[] {
  const rand = mulberry32([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
  const points: HistoryPoint[] = [];
  const day = 86_400_000;
  for (let i = 11; i >= 0; i--) {
    const drift = (v: number | null) => (v === null ? null : round2(Math.min(100, Math.max(0, v - i * (rand() - 0.3) * 2))));
    points.push({
      sha: hex(rand, 40),
      createdAt: new Date(Date.now() - i * 7 * day).toISOString(),
      quality: drift(score.quality),
      metrics: Object.fromEntries(Object.entries(score.metrics).map(([k, m]) => [k, drift(m.pct)])),
    });
  }
  return points;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(rand: () => number, length: number): string {
  return Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join("");
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
