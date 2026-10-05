# Handoff: build techtree and iterate against base/base

You're picking up a new project with a finished design and no code. Build it, dogfood it on base/base, and iterate until the acceptance checks below pass.

## Read first

1. `docs/DESIGN.md` in this repo. It is the spec and the source of truth: change the spec before changing behavior.
2. pi docs, under `PI=~/Library/Application\ Support/mux/runtime/agent/lib/node_modules/@cbhq/code-agent/node_modules/@earendil-works/pi-coding-agent`:
   - `$PI/docs/extensions.md`, `packages.md`, `rpc.md`, `rpc-commands.md`, `skills.md`, `sdk.md`
   - `$PI/examples/extensions/`, `$PI/examples/rpc-client.ts`
3. Host-portability rules: `~/Library/Application Support/mux/runtime/agent/lib/node_modules/@cbhq/code-agent/docs/pi-extension-authoring.md`. The important ones:
   - `ctx.ui.custom` returns `undefined` over RPC.
   - Background `info` notifies are dropped by some hosts.
   - Use `setWidget`, tools, `warning` notifies, or the web UI for asynchronous status.
   - Call dialogs instead of gating them on `ctx.hasUI`.

## Hard constraints (from the user)

- **Open source and host-neutral.** No imports, names or references specific to Toshi or Coinbase anywhere in the repo. It must still *work* under Toshi, which it will if it only uses standard pi extension APIs and a localhost URL.
- **Surface:** a localhost web app started by a pi extension (`/techtree`). Stack: TypeScript; Node built-ins (`node:http`, `node:sqlite`, `node:child_process`); Preact with hand-rolled SVG; esbuild. Add a dependency only when a few lines can't replace it.
- **Agents:** headless `pi --mode rpc` children, each in its own git worktree. PRs through the `gh` CLI. Never auto-merge. Each task has a "manual review before PR" checkbox, pre-ticked by the complexity heuristic in the design.
- **Scores:** the composite score is built from repo-relative percentiles of each metric, weighted by `.techtree.yaml`. Impact of a fix is estimated by applying the finding's `metricEffects` and recomputing.
- **State** lives in `~/.cache/techtree/<repo-id>/`. LLM scans run on demand and are cached by content hash. 3 workers by default.
- **Status:** the repo is local only and has no remote. Don't add a remote or publish without asking.

## Environment facts

- **Repos:**
  - This repo: `~/code/ext/brianbland/techtree` (branch `main`).
  - Dogfood target: `~/code/ext/base/base`, the canonical checkout. Treat it as **read-only**: score it in place, and do any agent task work in worktrees.
- **Worktrees:** for nontrivial work, follow `~/AGENTS.md`. Worktrees for this repo go in `~/code/worktrees/techtree/<desc>`; for base, `~/code/worktrees/base/<desc>`.
- **Node:** v22.23. `node:sqlite` works and prints an experimental warning; suppress it or ignore it.
- **base/base builds:**
  - **Shared target dir:** use `CARGO_TARGET_DIR=~/code/worktrees/base/.scan-target` so builds don't fill the disk (~150 GB free).
  - **rocksdb/libclang:** builds need `LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib` and `DYLD_FALLBACK_LIBRARY_PATH=/Library/Developer/CommandLineTools/usr/lib`.
  - **Foundry/contracts:** `forge` is not installed, so `cargo clippy --workspace` fails on `crates/utilities/test-utils` contract artifacts.
  - **Scope:** scope cargo with `-p`, or use base's `etc/scripts/local/affected-crates.py`. Set `BASE_SUCCINCT_ELF_STUB=1` for clippy and check.
  - **Clippy:** use `cargo clippy --message-format=json` for the lint plugin. Run it per crate and cache the results, because a full-workspace run is slow.
- **Available tools:** `gh` (logged in to github.com), `zepter`. `cargo nextest` may not be installed; treat `test_time` as optional.
- **Score sanity check:** base/base's recent code-scanning run found real bugs in these crates, which are useful to compare against:
  - `crates/execution/flashblocks`
  - `crates/proof/rpc`
  - `crates/proof/preimage`
  - `crates/proof/zk/witness`
  - `crates/common/rpc-types-engine`

## Workflow

Use the crew workflow: load the `feature` skill, and `orchestrate` before starting subagents. Take each subagent's model from `~/.pi/agent/extensions/crew/MODEL_MAP.md`. The work breakdown at the end of `DESIGN.md` is the plan:

1. **Subtask 0 yourself:** scaffold, `src/types.ts` (copy the contracts from the design), config loader, SQLite schema, `npm test` running Node's built-in test runner (`node --test`), and an esbuild build. Commit.
2. **In parallel, one builder per worktree:**
   - 1: scoring core
   - 2: generic, git and rust plugins
   - 3: LLM scan plugin and skill
   - 4: task runner and worker skill
   - 6: UI against a mock API
3. **Then** 5 (PRs/babysit, after 4) and 7 (extension glue and end-to-end).
4. **Merge** each subtask to `main` after a cross-family `code-reviewer` pass.

Before step 2, consider a short council on the two open risks:
- **Percentile impact estimates:** fixing one node shifts its neighbours' percentiles. The design holds the neighbours fixed; validate that this ranks fixes sensibly.
- **Server lifecycle:** one shared server per repo with a lockfile, versus one server per pi session.

## Iteration loop against base/base

1. **Score it:** `node dist/cli.js score ~/code/ext/base/base` (add a small CLI for headless runs). Print the top and bottom 10 nodes per metric and the top 20 findings by priority. Check them against intuition and the crates listed above, and tune default weights or plugins.
2. **Check what the UI shows:** run `/techtree` in a pi session opened in base/base. Check:
   - tree layout at full depth (base has hundreds of directories, so collapsing has to work)
   - weight and edge scaling
   - sorting and switching between scores
3. **Run a real task:** start one low-risk suggested task (e.g. a doc or error-text finding) with manual review ticked. Confirm:
   - a worktree is created
   - the research bar animates from plan to checklist progress
   - the task stops in `review` with a diff
   Then do one end to end with a real PR only after asking the user.
4. **Check PR anchoring:** use base/base's existing open PRs (`gh pr list -R base/base --author @me`) to confirm counts, the stale/stuck flags, and the babysit toggle in observe-only mode. Do not push fixes to someone else's PR.

## Acceptance (v1 done)

- **Full repo:** `score` on base/base finishes in under 2 minutes without LLM scans. Clippy results come from cache after the first run.
- **Tree view:**
  - renders the whole repo
  - switching score, weight metric and sort updates in under 200 ms
  - PR bubbles and research bars appear on the correct nodes
- **Node panel:** shows the metric breakdown with percentiles, findings ranked by estimated impact, PRs with a working babysit toggle, and tasks with a live log tail.
- **Overview:** lists tasks needing input, stuck or stale PRs, and suggested tasks biased toward low conflict.
- **Tasks:** a task runs end to end in a worktree, through both the manual-review path and the PR path. State survives a server restart.
- **Hosts:** works in plain `pi` and under an RPC host: `/techtree` returns the URL, and the tools work.
- **Hygiene:** a grep for host- or company-specific names (`toshi`, `mux`, `cbhq`, `coinbase`) in the repo returns nothing outside `docs/HANDOFF.md`. Delete this file before publishing. Unit tests cover aggregation, percentiles, composite, what-if impact, PR anchoring, and the complexity heuristic.

## Report back

When done: what works (with screenshots or the CLI output from base/base), deviations from `DESIGN.md` (with the spec updated to match), known gaps, and suggested v2 items.
