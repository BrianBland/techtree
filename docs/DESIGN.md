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

### v1 plugin metrics

Own values are per node: a directory's own files only; the core aggregates up. Density and ratio metrics hold a raw count and name their denominator in `normalizeBy`, so findings can state their effect as a count and parents aggregate correctly by summing.

| Metric | Own value | Direction | Aggregate | normalizeBy |
|---|---|---|---|---|
| `loc` | non-blank lines | neutral | sum | |
| `files` | counted files | neutral | sum | |
| `max_file_loc` | largest file's `loc` | lower_better | max | |
| `todo_density` | lines with `TODO`/`FIXME`/`XXX`/`HACK` | lower_better | sum | `loc` |
| `churn_90d` | lines added + deleted in the last 90 days | neutral | sum | |
| `authors_90d` | distinct author emails in the last 90 days | neutral | max | |
| `last_touched_days` | days since the newest commit touching an own file | neutral | max (stalest part) | |
| `open_pr_overlap` | open PRs changing an own file | neutral | max | |
| `fn_count` | `fn` items in non-test Rust code | neutral | sum | |
| `pub_fn_count` | `pub fn` items in non-test Rust code | neutral | sum | |
| `complexity` | branch points (`if`, `match`, `while`, `for … in`, `loop`, `&&`, `\|\|`) in non-test code | lower_better | sum | `fn_count` |
| `unwrap_density` | `.unwrap()` / `.expect(` in non-test code | lower_better | sum | `loc` |
| `test_count` | test fns (`#[test]`, `#[<path>::test]`, `#[rstest]`) | neutral | sum | |
| `test_ratio` | test fns (same count as `test_count`) | higher_better | sum | `pub_fn_count` |
| `ignored_tests` | `#[ignore]` attributes | lower_better | sum | |
| `fan_in` | workspace crates depending on this crate (crate nodes only) | neutral | max | |
| `lint_warnings` | clippy/rustc lint diagnostics in own files (linted crates only) | lower_better | sum | `loc` |
| `test_time` | seconds from nextest JUnit XML (crate nodes only) | neutral | sum | |

Git metrics are neutral: churn, authorship and recency describe how hot a node is (used by the complexity heuristic and as weights), not its quality. `open_pr_overlap` feeds conflict, not quality. Only history of files in the tree counts: excluded paths and files that no longer exist (deleted or moved away) are ignored, because they are not any node's own files.

Rules shared by the plugins:

- **Skipped files** (`generic`): binary files (NUL byte in the first 8 KB), files over 2 MB, lockfiles, minified `*.min.*` files, files under `vendor/` or `third_party/`, and files whose first lines say `@generated` or `DO NOT EDIT`.
- **Non-test Rust code** excludes files under a `tests/`, `benches/` or `examples/` directory and the bodies of `#[cfg(test)]` modules and test fns. Comments and string literals are ignored. The detection is lexical and approximate.
- **Crates** (`rust.annotate`): a directory whose `Cargo.toml` has a `[package]` section becomes kind `crate`, named after the package. `fan_in` counts dependents across all workspace `Cargo.toml` dependency tables. Renames via `package = "…"` are honoured, including aliases a member inherits with `workspace = true` from the root `[workspace.dependencies]`.
- **Clippy** runs only when `plugins.rust.clippy` is true or `TECHTREE_CLIPPY=1`. One `cargo clippy --message-format=json -p … <clippyArgs>` covers every crate whose key (hash of its files, the root `Cargo.toml`, `Cargo.lock`, `rust-toolchain[.toml]` and `clippyArgs`) is not cached. The child inherits the parent environment (e.g. `CARGO_TARGET_DIR`). A crate counts as linted when one of its targets other than the build script was checked (or reported lints) and it had no non-lint compile error. A crate that fails to build, including through a failing build script, gets no `lint_warnings`, is not cached, and is logged. Each diagnostic is counted once per primary source span, so repeated emissions (e.g. lib and test targets under `--all-targets`) collapse while separate occurrences on one line stay separate. `plugins.rust.exclude` lists crate names to skip.
- **test_time** sums `testsuite` times per package from `<target>/nextest/*/*.xml`, where `<target>` is `CARGO_TARGET_DIR` or `<repo>/target`.
- **open_pr_overlap** uses `gh pr list --state open --json number,files` when a remote points at GitHub, cached for 10 minutes; any failure yields 0.

Findings (ids hash source, file, rule and a snippet, never a line number):

| Source | Rule | Granularity | metricEffects |
|---|---|---|---|
| `large-file` | `large-file` | file with ≥ 1000 loc; ≥ 2000 medium/large, ≥ 4000 high/large | `max_file_loc` down to max(1000, next largest file) |
| `todo` | `todo-cluster` | file with ≥ 3 TODO lines | `todo_density: -n` |
| `clippy` | lint code | one per diagnostic; trivial when machine-applicable, else small | `lint_warnings: -1` |
| `test-gap` | `untested-pub-fn` | file whose `pub fn` names never appear in the crate's test code | `test_count: +n`, `test_ratio: +n` |
| `unwrap` | `unwrap-expect` | file with unwrap/expect in non-test code | `unwrap_density: -n` |

Clippy findings are tagged `concurrency` (lock, mutex, atomic, `Arc`, `Send`/`Sync`, await), `security` (unsafe, transmute, raw pointers, uninit) or `api` (`must_use`, docs, `new_without_default`, self conventions); untested public fns are tagged `api`.

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
