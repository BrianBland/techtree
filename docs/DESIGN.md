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
| `llm-scan` (on demand) | `review_debt` (severity-weighted, per kLOC) | each scanned issue, with severity, effort and a suggested fix |

**Impact estimation (what-if).** Fixing finding *f* applies `metricEffects` to its node's raw values, then recomputes aggregation, percentiles and composite for that node and its ancestors, holding everyone else fixed. impact(f) = Δquality at the node, and the root delta is shown alongside. A task's planned delta applies all its findings together.

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

- **Start:** the runner creates a worktree at `~/code/worktrees/<repo>/techtree-<task>` (`worktreeTemplate`: `{home}`, `{repo}` = repo dir name, `{task}` = task id) on a new branch `techtree/<task>` from `baseRef`, with `git worktree add`; the main checkout's working tree is never touched. It spawns `piCommand --mode rpc --session-dir <cache>/sessions/<task> --session-id <task> -e <package>/extensions --skill <package>/skills/techtree-worker` there, with `TECHTREE_URL`, `TECHTREE_TOKEN` and `TECHTREE_TASK` in the environment, and sends the task prompt as `/skill:techtree-worker <prompt>` plus the finish rule for the task's `manualReview` setting.
- **Queue:** at most `workers` tasks have a live child (`running` or `needs_input`); further tasks stay `queued` and start in creation order as slots free up. Resuming an existing task (an answer after restart, "Open PR", recovery) starts its child immediately, even if that briefly exceeds the limit.
- **Worker protocol:** the skill requires a checklist up front through the `techtree_report` tool (`{plan}`), then `{phase}` and `{done:i}` updates. When stuck, the worker calls `{needs_input: question}`, which pauses the task. `techtree_report` POSTs the payload to `$TECHTREE_URL/api/tasks/$TECHTREE_TASK/report?token=$TECHTREE_TOKEN`; one payload may carry several fields. Reports for tasks without a live worker, unknown phases, or out-of-range `done` indexes are rejected.
- **RPC events:** every event worth reading (assistant messages, tool calls, retries, dialogs, errors, stderr, state changes) becomes a timestamped line in `<cache>/tasks/<task>.log` and a `log` server event; every task change is persisted to SQLite and emitted as a `task` event.
  - An extension dialog (`select`, `confirm`, `input`, `editor`) moves the task to `needs_input` with the dialog text as the question. The answer is sent back as the dialog response: `confirm` is true when the answer starts with y/yes/ok/true/allow, other dialogs get the text as their value.
  - An answer to a reported `needs_input` question is sent as a follow-up prompt. Either way the task returns to `running`.
  - When the agent settles (`agent_settled`) while `running` and the task is not finished, the runner nudges once; if it settles unfinished again, the task moves to `needs_input`. Any report or answer re-arms the nudge.
  - If the child exits while the task is `queued`, `running` or `needs_input`, the task becomes `failed` with the exit code and log path.
- **Finish:** a task is finished when its checklist is non-empty and fully ticked and, in the PR stage, `gh pr view <branch> --json number` finds the PR. The PR stage is every task without `manualReview`, and a `manualReview` task after "Open PR".
  - With `manualReview`, the worker commits and stops; the runner moves the task to `review` and ends the child. The diff is `git diff <baseRef>...HEAD` in the worktree, where `baseRef` is resolved in the main checkout. The UI shows it with an "Open PR" button.
  - "Open PR" (`review` → `running`, phase `pr`) resumes the same pi session with an instruction to push to the upstream remote and open the PR with `gh`, following the repo's PR template.
  - Otherwise the worker opens the PR itself in one go. Once the PR number is found the task records it, moves to `pr_open` and the child is ended. Nothing ever merges.
- **Cancel:** stops the child (if any) and marks the task `failed` with error `cancelled`. The worktree is kept.
- **Babysit:** on PR events (CI failure, new review thread, conflict), the poller resumes the task's pi session or starts a `techtree-babysit` child with that context. It stops at ready-to-merge, merged, closed, or after 3 failed fix attempts. It never merges.
- **Recovery:** task state lives in SQLite. RPC runs over the child's stdio, so a new server cannot reattach to an old child; and when the server dies, the child's stdin closes and pi shuts down. On start, for each task persisted as `running` or `needs_input`, the runner stops any process still alive at the recorded pid.
  - If the task's pi session file exists, `running` tasks are respawned on that session (`--session-id`) with a short "continue" prompt. `needs_input` tasks keep their question and respawn on that session when answered; an answer to a lost dialog is sent as a prompt.
  - Without a session file the task is marked `failed`, with the log path in `error`.
  - `queued` tasks start as slots allow. `review`, `pr_open`, `done` and `failed` tasks are left untouched.

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
