import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const reportParameters = Type.Object({
  plan: Type.Optional(Type.Array(Type.String(), { description: "Checklist of steps, sent once before any work" })),
  phase: Type.Optional(
    Type.Union([Type.Literal("plan"), Type.Literal("explore"), Type.Literal("edit"), Type.Literal("test"), Type.Literal("pr")], {
      description: "Current phase of the task",
    }),
  ),
  done: Type.Optional(Type.Integer({ minimum: 0, description: "Index of the checklist item just completed" })),
  needs_input: Type.Optional(Type.String({ description: "Question for the user; pauses the task until answered" })),
  items: Type.Optional(
    Type.Array(
      Type.Object({
        node: Type.String({ description: "Repo-relative directory the item belongs to; \"\" = repo root" }),
        title: Type.String(),
        detail: Type.String(),
        effort: Type.Union([Type.Literal("trivial"), Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]),
        severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
      }),
      { description: "Plan tasks only: work items toward the project goal" },
    ),
  ),
  scorer: Type.Optional(
    Type.Object(
      {
        rubric: Type.Optional(Type.String({ description: "What an LLM scan of each file should look for" })),
        command: Type.Optional(Type.Array(Type.String(), { description: "argv run in the repo root that prints scorer JSON" })),
        plan: Type.Optional(Type.Boolean({ description: "Score progress on reported plan items" })),
      },
      { description: "Scorer tasks only: the proposed project scorer" },
    ),
  ),
  outcome: Type.Optional(Type.Literal("no_change", { description: "Finish without changes: the right answer is that nothing should change" })),
  summary: Type.Optional(Type.String({ description: "With outcome no_change: why nothing should change" })),
  dismiss: Type.Optional(Type.Array(Type.String(), { description: "Finding ids to propose dismissing (false positive / won't fix); the user confirms" })),
  reason: Type.Optional(Type.String({ description: "With dismiss: why the findings should be dismissed" })),
});

/** Body of `POST /api/tasks/:id/report`. */
export type ReportPayload = Static<typeof reportParameters>;

/**
 * Worker progress tool for techtree task children. Registered by the techtree extension; it posts
 * to the server named by `TECHTREE_URL`, `TECHTREE_TOKEN` and `TECHTREE_TASK`.
 */
export const techtreeReportTool: ToolDefinition<typeof reportParameters> = {
  name: "techtree_report",
  label: "techtree report",
  description:
    "Report techtree task progress: {plan: string[]} first, then {phase}, {done: index} as checklist items finish, " +
    "or {needs_input: question} when blocked (then stop and wait for the answer). " +
    "Plan tasks report work items with {items}; scorer tasks propose a scorer with {scorer}. " +
    "When nothing should change, {outcome: \"no_change\", summary} ends the task; {dismiss: [findingId], reason} proposes dismissing findings.",
  parameters: reportParameters,
  async execute(_toolCallId, params) {
    const { TECHTREE_URL: url, TECHTREE_TOKEN: token = "", TECHTREE_TASK: task } = process.env;
    if (!url || !task) throw new Error("techtree_report only works inside a techtree task (TECHTREE_URL/TECHTREE_TASK unset)");
    const res = await fetch(`${url}/api/tasks/${encodeURIComponent(task)}/report?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`techtree_report rejected (${res.status}): ${await res.text()}`);
    const text = params.needs_input
      ? "Question sent. Stop now and wait for the answer."
      : params.outcome
        ? "Task finished without changes. Stop now."
        : "Reported.";
    return { content: [{ type: "text", text }], details: undefined };
  },
};
