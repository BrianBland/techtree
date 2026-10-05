---
name: techtree-babysit
description: Babysit one open pull request for techtree. Use when a techtree prompt says a PR needs attention (CI failing, changes requested, new review, merge conflict) to triage, make the smallest fix, push it to the PR branch and report through techtree_report. Never merges.
---

# techtree babysit

The prompt names one PR (number, URL, title, head branch) and what changed. You run in a worktree checked out on that PR, on a local branch whose upstream is the PR's head branch. Nobody watches your session; the techtree UI shows only what you report through `techtree_report`.

## Protocol

1. **Plan first.** Look at what needs attention (below), then call `techtree_report` with `{plan: [...]}`: 1–5 concrete steps. Tick each with `{done: <index>}` as you finish it; you are done only when every step is ticked. Report `{phase}` changes (`explore`, `edit`, `test`, `pr`).
2. **Triage.**
   - CI: `gh pr checks <number>`, then `gh run view <run-id> --log-failed` for failing runs. Separate real failures caused by the PR from flaky or infrastructure failures. Do not "fix" a flake by changing code; note it in your report.
   - Reviews: `gh pr view <number> --comments` and `gh api repos/{owner}/{repo}/pulls/<number>/comments` for inline threads.
   - Conflicts: `git fetch` the base branch and merge it into the PR branch (do not rebase or force-push unless the repository's conventions require it).
3. **Verify review comments before acting.** Read the code a comment points at and check that the claim holds. Apply comments that are correct; for ones that are wrong or out of scope, do not change code; explain why in your final message.
4. **Smallest fix.** Change only what the failure or comment requires. Run the relevant tests and linters locally before pushing.
5. **When blocked**, for example on a product decision, a disagreement with a reviewer, or missing access, call `{needs_input: "<one clear question>"}` and stop.

## Pushing and replying

- Commit with a descriptive message and push to the PR's head branch: `git push <upstream remote> HEAD:<head branch>` (the upstream is configured on your local branch: `git rev-parse --abbrev-ref @{upstream}`). Never push to any other branch, never force-push over someone else's commits.
- You may reply to review threads to say what you changed or why you did not. **Never resolve threads opened by other people**; the reviewer resolves them.
- **Never merge**, enable auto-merge, approve, or close the PR, even when everything is green.

## Finishing

When every checklist step is ticked, stop with a short summary: what failed or was asked, what you changed (commits pushed), and anything you deliberately left alone (flakes, declined comments) with the reason.
