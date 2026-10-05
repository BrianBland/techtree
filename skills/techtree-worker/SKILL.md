---
name: techtree-worker
description: Protocol for headless techtree task workers. Use when running as a techtree task (TECHTREE_TASK is set) to report plan, progress and questions through techtree_report, then commit and, when allowed, open a PR.
---

# techtree worker

You are working on one techtree task in your own git worktree and branch. Nobody watches your session; the techtree UI shows only what you report through the `techtree_report` tool.

## Protocol

1. **Plan first.** Before editing anything, explore just enough to call `techtree_report` with `{plan: [...]}`: 2–7 short, concrete checklist steps. Send it once. Sending a new plan resets the checklist.
2. **Report the phase** whenever it changes: `{phase: "explore" | "edit" | "test" | "pr"}`.
3. **Tick steps** as you finish them: `{done: <0-based index>}`. The task is not finished until every step is ticked.
4. **When blocked**, for example on an ambiguous requirement, a risky or destructive choice, or missing access, call `{needs_input: "<one clear question>"}` and then stop. The answer arrives as your next message. Do not guess on product or API decisions.
5. **Stay in scope.** Only change what the task asks for. Run the relevant tests and linters before you finish.

## Finishing

- **Commit** your work on the current branch with a descriptive message. Never commit to or check out other branches, and never touch the main checkout.
- **Manual review on** (the prompt says so): after committing, stop. Do not push or open a PR. If you are later told the review is approved, report `{phase: "pr"}` and open the PR as below.
- **Manual review off:** after committing, report `{phase: "pr"}`, push the branch to the upstream repository's remote (check the remote URLs; do not assume `origin` is the upstream or push to a fork), and open the PR with `gh pr create`.
- **PR rules:** find and follow the repository's PR template (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`, `docs/pull_request_template.md` or similar), keep its required sections, and put any mandated trailing metadata last. Summarize the change and how you tested it. **Never merge**, enable auto-merge, or approve your own PR.

## Scorer and plan tasks

Some tasks change no repository code; the prompt says which. Follow the protocol above (plan, phases, ticks, questions), but never edit, commit, push or open a PR.

- **Plan task:** read the repository and break the project goal into work items, each small enough for one PR. Report them with `techtree_report({items: [{node, title, detail, effort, severity?}]})`: `node` is the repo-relative directory the item mostly touches (`""` for the root), `effort` is `trivial`, `small`, `medium` or `large`, `severity` (importance) `low`, `medium` or `high`. A rejected report names the bad items; fix and resend them.
- **Scorer task:** design how the project's progress is measured. Propose it with `techtree_report({scorer: {rubric?, command?, plan?}})`. A `rubric` tells an LLM scan of each file what to look for. A `command` is an argv run in the repo root that prints the scorer JSON described in the prompt; put its scripts only in the scripts directory the prompt names, and run them once to check their output. `plan: true` scores progress on plan items. The user reviews the proposal and may reply; send a revised proposal each time.
