---
name: techtree-scan
description: Review a batch of source files for real defects and print them as a strict JSON array of findings. Used by techtree's on-demand LLM scan; invoke explicitly with /skill:techtree-scan.
disable-model-invocation: true
---

# techtree scan

You review the files given after this skill (each starts with `=== <path> ===`, lines prefixed by their number). Find problems worth a maintainer's time. You may read other files in the repo for context; never modify anything.

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
- `tags`: any of `concurrency`, `security`, `api`, `error-handling`, `correctness`, `performance`, `resource-leak`, `testing`, `docs`, `maintainability`.
- `metricEffects`: optional; other techtree metrics the fix would change, e.g. `{ "unwrap_density": -1 }` for removing one unwrap. Leave `{}` when unsure.

## Calibration

- Prefer real bugs over style. Do not report formatting, naming taste, or anything a linter already flags.
- Be specific: cite the exact code path. If you are not confident it is a problem, leave it out.
- Report one issue per item; merge duplicates of the same pattern in one file into one item.
- At most 10 items per batch, most severe first.
