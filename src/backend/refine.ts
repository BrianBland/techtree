import { runPiPrint } from "../plugins/llm-scan.ts";
import type { Config } from "../types.ts";

export type RefineKind = "goal" | "rubric";
export const REFINE_KINDS: RefineKind[] = ["goal", "rubric"];
const TIMEOUT_MS = 5 * 60_000;

const PURPOSE: Record<RefineKind, string> = {
  goal:
    "the goal of a techtree project: every agent working on the project's tasks sees it, and it drives drafting the project's scorer and planning its work. " +
    "Make it specific and outcome-oriented, measurable where the user's intent allows, scoped to this repository (use read/grep/find/ls to check names and layout), and concise: a short paragraph or a few bullets.",
  rubric:
    "the rubric of a techtree project: an LLM scanning each source file uses it to decide what to report as findings. " +
    "Make it a clear checklist of concrete, checkable patterns, each with a brief example of what counts and what does not (to avoid false positives), " +
    "naming this repository's real idioms where useful (use read/grep/find/ls to check), and how severe each pattern is.",
};

/** Rewrite a project goal or rubric with an agent (DESIGN "Refining text"); resolves the refined text. */
export async function refineText(
  input: { kind: RefineKind; text: string; name?: string; goal?: string },
  config: Config,
  repoRoot: string,
): Promise<string> {
  const model = config.refineModel || config.defaultModel;
  const context = [input.name && `Project: ${input.name}`, input.kind === "rubric" && input.goal && `Project goal: ${input.goal}`].filter(Boolean);
  const prompt = [
    `Refine ${PURPOSE[input.kind]}`,
    "Keep the user's intent and every constraint they stated; do not invent requirements. Reply with the refined text only: no preamble, no explanation, no code fences.",
    ...context,
    `Text to refine:\n${input.text}`,
  ].join("\n\n");
  const out = await runPiPrint(config.piCommand, repoRoot, ["--tools", "read,grep,find,ls", ...(model ? ["--model", model] : []), prompt], TIMEOUT_MS);
  const text = out.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, "$1").trim();
  if (!text) throw new Error("the agent returned no text");
  return text;
}
