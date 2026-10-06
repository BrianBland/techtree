import type { PrState, Task } from "../types.ts";

export type OutboxSection = "needs_you" | "babysitting" | "waiting";

/** Which outbox section a PR belongs to and its one-line status (DESIGN "Outbox"). */
export function outboxEntry(pr: PrState, task?: Task): { section: OutboxSection; status: string } {
  const needsYou = (status: string) => ({ section: "needs_you" as const, status });
  const status = pr.babysitStatus ?? "";
  if (pr.ci === "pass" && pr.review === "APPROVED" && pr.mergeable === "MERGEABLE") return needsYou("ready to merge — merge on GitHub");
  if (!pr.babysit && status.startsWith("gave up")) return needsYou(status);
  if (pr.babysit && status.startsWith("observe-only")) return needsYou(status);
  const problems = [
    pr.review === "CHANGES_REQUESTED" && "changes requested",
    pr.mergeable === "CONFLICTING" && "merge conflict",
    pr.ci === "fail" && "CI failing",
  ].filter(Boolean);
  if (!pr.babysit && problems.length) return needsYou(`${problems.join(", ")} · babysit off`);
  if (task?.state === "needs_input") return needsYou(`agent asks: ${task.question ?? "a question"}`);
  if (task?.state === "review") return needsYou("fix ready for review");
  if (pr.stuck) return needsYou("no progress in 24h");
  if (pr.stale) return needsYou("no update in 3 days");
  if (pr.babysit) return { section: "babysitting", status: status || "waiting for CI or review" };
  return { section: "waiting", status: pr.ci === "pending" ? "CI running" : "waiting for review" };
}
