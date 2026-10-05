---
name: techtree-scan
description: Review a batch of source files for real defects, slop, duplication, comment noise and weak tests, and print them as a strict JSON array of findings. Used by techtree's on-demand LLM scan; invoke explicitly with /skill:techtree-scan.
disable-model-invocation: true
---

# techtree scan

You review the files given after this skill (each starts with `=== <path> ===`, lines prefixed by their number). Find problems worth a maintainer's time. You may read other files in the repo for context; never modify anything.

## Focus areas, in priority order

1. **Real bugs first**: crashes, data loss, security holes, deadlocks, races, wrong results, swallowed errors, missing validation at a trust boundary.
2. **Slop** (`slop`): code that is longer or more indirect than the problem needs: needless abstraction (a trait, generic or wrapper with one user), over-engineering for cases that cannot happen, defensive noise (re-checking what the type system or the caller already guarantees, `clone()`s and conversions that do nothing), dead parameters and branches.
3. **Duplication** (`duplication`): logic repeated across functions or files that should be one function, macro or table, including near-copies that differ only in names or literals. Name every copy in `detail`.
4. **Comment noise** (`comment-noise`): comments that restate the next line, section banners and dividers, commented-out code, changelog or "removed/old" notes, stale comments that contradict the code. Doc comments on public API, license headers, `SAFETY:` and why-comments are not noise.
5. **Test quality** (`testing`): tests that assert nothing or only assert constants, tests that duplicate each other (merge into a table-driven test), tests that check the mock instead of the code, tests so long that a failure does not say what broke, and missing tests only where an untested path is risky.

## Output

Reply with **only** a JSON array, no prose before or after. `[]` means nothing worth reporting. Each item:

```json
{
  "title": "Lock held across await in flush()",
  "detail": "What is wrong, when it bites, and why it matters. Two to four sentences.",
  "file": "src/queue.rs",
  "line": 88,
  "severity": "high",
  "effort": "small",
  "tags": ["concurrency"],
  "suggestedFix": "Clone the batch under the lock, drop the guard, then await the send.",
  "metricEffects": {}
}
```

- `file`: exactly one of the given paths. `line`: 1-based line of the problem, omit if not line-specific.
- `severity`: `high` = likely bug, data loss, security hole, crash, or deadlock in realistic use; `medium` = incorrect behavior in edge cases, error swallowing, missing validation at a boundary, misleading public API; `low` = real but minor: confusing code that invites bugs, missing docs on public API, dead code.
- `effort` to fix, including tests: `trivial` (a line or two), `small` (one function), `medium` (several functions or a file), `large` (cross-module or design change).
- `tags`: any of `concurrency`, `security`, `api`, `error-handling`, `correctness`, `performance`, `resource-leak`, `testing`, `docs`, `maintainability`, `slop`, `duplication`, `comment-noise`.
- `metricEffects`: optional; other techtree metrics the fix would change, as counts: `unwrap_density` (unwrap/expect calls removed, negative), `dup_lines` (duplicated lines removed, negative), `comment_noise` (noise comment lines removed, negative), `test_smells` (weak tests fixed or merged, negative), `test_count` (tests added, positive). Example: `{ "dup_lines": -24 }` for merging two 12-line copies. Leave `{}` when unsure.

## Calibration

- Prefer real bugs over style: a batch with a real bug lists it first. Do not report formatting, naming taste, or anything a linter already flags.
- Slop, duplication, comment noise and test quality are `low` severity unless they hide a bug (`medium`: e.g. a copy that has drifted from the original and is now wrong, or a test that cannot fail guarding critical logic). Their effort is usually `trivial` (delete comments or a dead branch), `small` (merge tests, inline a wrapper) or `medium` (extract a shared function across files).
- Report a pattern once per file with every location in `detail` (e.g. "4 comments restate the next line: lines 12, 30, 41, 77"), not once per line.
- Be specific: cite the exact code path. If you are not confident it is a problem, leave it out.
- Report one issue per item; merge duplicates of the same pattern in one file into one item.
- At most 10 items per batch, most severe first.
