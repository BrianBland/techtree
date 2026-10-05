# techtree — design

A pi package that shows a repository as an RPG-style tech tree: every directory is a node, scored for quality, with live agent work and PRs overlaid. From the tree you can start improvement tasks and babysit PRs.

Open source, with no dependency on any specific pi host. It works in plain pi, in the pi TUI, and in any host that can open a URL.

## Decisions

| Topic | Decision |
|---|---|
| Surface | A pi extension serves a localhost web app; `/techtree` starts it and prints the URL. |
| Agents | Headless pi child processes (`pi --mode rpc`), one per task, each in its own git worktree. |
| PRs | `gh` CLI polling. No GitHub App, no webhooks. |
| Tree | The directory tree is the core. Plugins can name and annotate nodes; for example, a Cargo crate root becomes a "crate" node. |
| Scores | Each metric is turned into a percentile against the repo's other nodes of the same kind, and a weighted composite of those gives a 0–100 quality score. Weights live in config. |
| Progress | Planned delta = the sum of the estimated impacts of the task's findings. Fill comes from checklist completion and the current phase. |
| Autonomy | Each task has a "manual review before PR" checkbox, pre-ticked when the complexity heuristic says so. Nothing ever auto-merges. |
| LLM scans | On demand per subtree, cached by file content hash. |
| State | User cache: `~/.cache/techtree/<repo-id>/` (SQLite via `node:sqlite`, plus per-task logs). Optional repo config at `.techtree.yaml`. |
| Concurrency | 3 workers by default (configurable); further tasks queue. |
| Stack | TypeScript. Node server: `node:http`, `node:sqlite`, no framework. Front end: Preact with hand-rolled SVG, built with esbuild. |

## Architecture

```
pi extension (techtree)
 ├─ /techtree command → start server, notify URL
 ├─ tools: techtree_status, techtree_findings, techtree_report (worker progress)
 └─ server (node:http, localhost, random port, token in URL)
     ├─ REST + SSE API  ←→  web UI (Preact/SVG)
     ├─ scorer pipeline  → metric plugins → sqlite
     ├─ task runner      → pi --mode rpc children in worktrees
     └─ PR poller        → gh pr list/view/checks
```

There is one server per repo, shared by every pi session in that repo through a lockfile (`server.json`: pid, port, token) in the cache dir. The server runs as a detached Node process (`techtree serve <repo>`) so tasks outlive the pi session that started it; `/techtree` starts it when the lockfile is missing or stale and reuses it otherwise.

## Data model (contract for all subtasks)

`src/types.ts` is the authoritative copy of these contracts. Beyond the summary below it adds: `TreeNode.parent`; `Tree` (`repoRoot` + `nodes` by id); `CollectCtx` (repo root, tree, config, a `Cache` keyed by kind and key, logger, abort signal); `Finding.tags` (used by the complexity heuristic); `Task.prompt`, `question`, `error`, `pid`, `logPath`, timestamps; `PrState.title`, `author`, `taskId`; the scoring output (`MetricScore`, `NodeScore`, `Impact`, `ScoreResult`, `Suggestion`); `Config`; and the HTTP API payloads below.

```ts
type NodeId = string;              // repo-relative dir path, "" = root
interface TreeNode { id: NodeId; name: string; kind: string /* "dir" | "crate" | ... */; children: NodeId[]; files: string[] }

interface MetricDef {
  key: string;                     // "loc", "test_count", "lint_warnings", ...
  label: string;
  unit?: string;
  direction: "higher_better" | "lower_better" | "neutral";   // neutral = weight-only (e.g. loc)
  aggregate: "sum" | "max" | "mean_by_loc";                   // how parents combine children
  normalizeBy?: string;            // e.g. lint_warnings per "loc" before percentile
}
interface MetricPlugin {
  id: string;
  metrics: MetricDef[];
  annotate?(tree: Tree): void;     // rename/kind nodes (cargo: crate names)
  collect(ctx: CollectCtx): Promise<Record<NodeId, Record<string, number>>>;  // leaf/own values
  findings?(ctx: CollectCtx): Promise<Finding[]>;
}
interface Finding {
  id: string;                      // stable hash of (source, file, rule, snippet)
  node: NodeId; file?: string; line?: number;
  source: string;                  // "clippy", "llm-scan", "test-gap", ...
  title: string; detail: string;
  severity: "low" | "medium" | "high";
  effort: "trivial" | "small" | "medium" | "large";
  metricEffects: Record<string, number>;   // e.g. { lint_warnings: -1 } if fixed
}
interface Task {
  id: string; node: NodeId; title: string; findingIds: string[];
  state: "queued" | "running" | "needs_input" | "review" | "pr_open" | "done" | "failed";
  manualReview: boolean; worktree?: string; branch?: string; pr?: number;
  plannedFrom: number; plannedTo: number;   // composite scores
  checklist: { text: string; done: boolean }[]; phase: "plan" | "explore" | "edit" | "test" | "pr";
}
interface PrState { number: number; url: string; node: NodeId; files: string[]; ci: "pass" | "fail" | "pending";
  review: string; updatedAt: string; babysit: boolean; stale: boolean; stuck: boolean }
```

## Scoring

1. **Collect.** Each plugin returns its own values per node. The core aggregates them up the tree using each metric's `aggregate`.
2. **Normalize.** Metrics with `normalizeBy` are divided first, so lint warnings are counted per kLOC. Each node then gets a percentile among peers of the same `kind` with at least `minLoc` lines; tiny nodes inherit their parent's percentile. `lower_better` metrics are flipped.
3. **Composite.** quality = Σ wᵢ·pctᵢ / Σ wᵢ over the metrics present. The weights come from `.techtree.yaml`, with defaults provided.
4. **History.** Every scoring run writes a snapshot (commit sha, timestamp), giving sparklines and before/after comparisons for merged tasks.

The v1 plugins are listed below.

| Plugin | Metrics | Findings |
|---|---|---|
| `generic` | `loc`, `files`, `max_file_loc`, `todo_density` | very large files, TODO/FIXME clusters |
| `git` | `churn_90d`, `authors_90d`, `last_touched_days`, `open_pr_overlap` | — |
| `rust` | crate annotation, `fn_count`, `complexity` (approx.), `unwrap_density`, `test_count`, `test_ratio`, `ignored_tests`, `lint_warnings` (clippy JSON), `test_time` (nextest JUnit, if present) | clippy diagnostics, untested public fns, unwrap/expect in non-test code |
| `llm-scan` (on demand) | `review_debt` (severity-weighted, per kLOC of scanned code), `scanned_loc` | each scanned issue, with severity, effort and a suggested fix |

**Impact estimation (what-if).** Fixing finding *f* applies `metricEffects` to its node's raw values, then recomputes aggregation, percentiles and composite for that node and its ancestors, holding everyone else fixed. impact(f) = Δquality at the node, and the root delta is shown alongside. A task's planned delta applies all its findings together.

### LLM scan

`scanNode(node, ctx, opts)` in `src/plugins/llm-scan.ts` reviews the files of a subtree (the node and all descendants) with the `techtree-scan` skill.

1. **Select.** Subtree files sorted by path, skipping binary files (containing a NUL byte) and files larger than `batchBytes`; at most `maxFiles` are kept.
2. **Batch.** Files are chunked in order into batches of at most `batchFiles` files and `batchBytes` bytes. Batch key = sha256 of (SKILL.md contents, each path and its contents).
3. **Run.** A cached batch costs nothing. Otherwise pi runs once per batch, at most `concurrency` at a time, with cwd = repo root: `<piCommand> -p --no-session --tools read,grep,find,ls --skill <package>/skills/techtree-scan "/skill:techtree-scan <files with numbered lines>"`. A run that exits nonzero, times out (`timeoutMs`), or prints no JSON array fails that batch; failures are reported and not cached, and never throw. Aborting the signal kills running children, skips pending batches, and rejects with the abort reason.
4. **Parse.** The final text must contain a JSON array (bare, in a ```json fence, or between the first `[` and last `]`). Items need a non-empty `title`, a `detail` string, a `file` from the batch, a valid `severity` and `effort`; optional `line` (positive integer), `tags` (strings), `suggestedFix` (string, appended to the detail) and `metricEffects` (finite numbers). Malformed items are dropped and the rest kept.
5. **Store** in `ctx.cache` kind `llm-scan`: `batch:<key>` → the batch's findings, and `file:<path>` → `{ sha, loc, findings }` for every file in the batch (an empty list means scanned and clean).
6. **Progress.** `opts.onProgress` receives `{ done, total, cached, failed, findings }` after each batch.

Options come from `config.plugins["llm-scan"]`, overridable per call: `concurrency` (2), `maxFiles` (200), `batchFiles` (20), `batchBytes` (60000), `timeoutMs` (600000).

**Scoring reads only the cache, never pi.** A file counts as scanned when its `file:<path>` entry's `sha` matches the file's current contents. For each node with scanned own files: `review_debt` = Σ severity weight of their findings (low 1, medium 3, high 9; `aggregate: sum`, `normalizeBy: scanned_loc`, `lower_better`), and `scanned_loc` = their summed line count (`neutral`, `sum`). Nodes with no scanned files get neither metric. Each cached finding becomes a `Finding` with `source: "llm-scan"`, `node` = the file's directory, id = hash of (source, file, title), and `metricEffects.review_debt` = −weight (overriding any model-supplied value). `scanCoverage(ctx)` returns the overview `coverage`: nodes with any scanned own file, total nodes, scanned and total lines.

**Priority** of a suggested task = impact ÷ effort cost × (1 − conflict), where conflict ∈ [0,1] is the overlap of its files and directories with running tasks' worktree diffs and open-PR file lists.

## UI

- **Tree:** left to right, root to deepest directory, as a tidy tree with collapse/expand and zoom/pan. Node size and edge width scale with √weight; the weight metric is selectable (loc, test_count, test_time, …). Node fill comes from the selected score: a single-hue ramp normalized to the repo's range. Siblings are sorted by a selectable key (default: alphabetical).
- **Overlays:** running tasks appear as a research bar under the node. The bar is solid up to `plannedFrom`, then shows a loading stripe up to `plannedTo` filled to checklist completion, then empty. Its color follows the score ramp. Open PRs appear as a count bubble on the top-right corner of their anchor node. The anchor is the deepest node that contains at least 60% of the PR's changed lines.
- **Node panel** (on click): composite score and per-metric breakdown with percentiles and sparklines, findings ranked by impact, open PRs with a babysit toggle, running tasks with live log tail, and suggested next tasks. Starting a task asks for the manual-review checkbox (pre-ticked by the heuristic) and lets you edit the prompt.
- **Overview** (no selection): calls to action:
  1. tasks in `needs_input` or `review`
  2. PRs that are failing, stuck (no progress in 24h), or stale (no update in 3 days)
  3. the top suggested tasks by priority, favouring low conflict
  4. a scan-coverage summary

**Complexity heuristic** for pre-ticking manual review: tick it if any of these hold:
- the effort is `medium` or larger,
- there is more than one finding,
- the node is "hot" (top-decile churn or fan-in),
- a finding is tagged `concurrency`, `security` or `api`.

## Agents

- **Start:** the runner creates a worktree at `~/code/worktrees/<repo>/techtree-<task>` (configurable template) and spawns `pi --mode rpc` there. It sends the task prompt and loads the `techtree-worker` skill.
- **Worker protocol:** the skill requires a checklist up front through the `techtree_report` tool (`{plan}`), then `{phase}` and `{done:i}` updates. When stuck, the worker calls `{needs_input: question}`, which pauses the task. The runner also reads RPC events to detect when the worker is idle, waiting on a dialog, or has exited.
- **Finish:** with `manualReview`, the worker commits and stops in `review`; the UI shows the diff with an "Open PR" button. Otherwise the worker opens the PR itself, following the repo's PR template and pushing to the upstream remote.
- **Babysit:** on PR events (CI failure, new review thread, conflict), the poller resumes the task's pi session or starts a `techtree-babysit` child with that context. It stops at ready-to-merge, merged, closed, or after 3 failed fix attempts. It never merges.
- **Recovery:** task state lives in SQLite, so a server restart reattaches to live child processes by pid, or marks those tasks failed with a link to their log.

## Configuration

`.techtree.yaml` at the repo root, merged over defaults. Supported YAML subset: nested block mappings, block lists of scalars, flow lists (`[a, b]`), scalars and `#` comments.

```yaml
weights: { }          # metric key → composite weight (defaults in src/config.ts)
minLoc: 200           # smaller nodes inherit their parent's percentile
workers: 3
worktreeTemplate: "{home}/code/worktrees/{repo}/techtree-{task}"
baseRef: HEAD         # ref task worktrees branch from
piCommand: [pi]       # argv prefix for pi children; env TECHTREE_PI overrides the default
ignore: [target, node_modules, .git]
plugins:              # per-plugin options, e.g.
  rust: { }
```

## HTTP API

All routes are under `/api`, require the token, and return JSON. Payload types are in `src/types.ts`.

| Route | Result |
|---|---|
| `GET /api/state` | `ApiState`: repo, latest snapshot, tree, metric defs, weights, scores, tasks, PRs, finding counts |
| `GET /api/node?id=<node>` | `ApiNode`: score, history, findings with impact, PRs, tasks, suggestions |
| `GET /api/overview` | `ApiOverview`: attention tasks, flagged PRs, suggestions, scan coverage |
| `GET /api/events` | SSE stream of `ServerEvent` |
| `GET /api/tasks/:id/log?tail=N` | last N log lines (text) |
| `GET /api/tasks/:id/diff` | worktree diff against the base (text) |
| `POST /api/tasks` | body `StartTaskRequest` → `Task` |
| `POST /api/tasks/:id/answer` | body `{ text }`: answer a `needs_input` question |
| `POST /api/tasks/:id/open-pr` | `review` → `pr_open` |
| `POST /api/tasks/:id/cancel` | stop the child, mark `failed` |
| `POST /api/prs/:number/babysit` | body `{ on: boolean }` |
| `POST /api/score` | rescore the repo |
| `POST /api/scan` | body `{ node }`: run the LLM scan on a subtree |
| `POST /api/tasks/:id/report` | worker progress from `techtree_report` (`{plan}`, `{phase}`, `{done}`, `{needs_input}`) |

## Security

The server binds 127.0.0.1 only and requires a random token in the URL (cookie after the first request). Every mutating endpoint requires the token. Workers inherit the user's pi configuration and sandbox, and techtree adds no privileges.

## Out of scope for v1

Multi-repo views, team-shared history, auto-merge, scheduled scans, non-Rust language plugins beyond `generic`.

## Work breakdown

| # | Subtask | Depends on | Output |
|---|---|---|---|
| 0 | Repo scaffold, contracts (`src/types.ts`), config loader, sqlite schema | — | buildable package skeleton |
| 1 | Tree builder + aggregation + percentile/composite + what-if impact | 0 | `core/` with unit tests on a fixture repo |
| 2 | Plugins: `generic`, `git`, `rust` | 0 | `plugins/`, tested on fixtures and base/base |
| 3 | `llm-scan` plugin + `techtree-scan` skill (finding schema, impact fields) | 0 | skill + plugin, cached by content hash |
| 4 | Task runner (worktrees, pi RPC children, progress protocol, recovery) + `techtree-worker` skill | 0 | `runner/` |
| 5 | PR poller + anchoring + babysit loop + `techtree-babysit` skill | 0, 4 | `prs/` |
| 6 | HTTP/SSE API + web UI (tree, overlays, panel, overview) | 0, with a mock API until 1/2/4/5 land | `server/`, `web/` |
| 7 | pi extension glue (`/techtree`, tools, lockfile, setWidget status) + end-to-end smoke test on base/base | all | release-ready package |
