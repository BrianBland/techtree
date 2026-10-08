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
  const out = await runPiPrint(config.piCommand, repoRoot, ["--tools", "read,grep,find,ls", ...(model ? ["--model", model] : [])], TIMEOUT_MS, undefined, { input: prompt });
  const text = out.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, "$1").trim();
  if (!text) throw new Error("the agent returned no text");
  return text;
}

/** A PR title for several changes from a cheap model (DESIGN "Staging and combined PRs"); undefined when it fails. */
export async function combinedTitle(changes: string[], config: Config, cwd: string): Promise<string | undefined> {
  const model = config.titleModel || config.defaultModel;
  const prompt =
    "Write one pull request title (conventional style, imperative, at most 72 characters) that covers all of these changes. Reply with the title only.\n\n" +
    changes.map((c) => `- ${c}`).join("\n");
  const out = await runPiPrint(config.piCommand, cwd, ["--no-tools", ...(model ? ["--model", model] : [])], 60_000, undefined, { input: prompt }).catch(() => "");
  const title = out.trim().replace(/^```[a-z]*\n?|```$/g, "").trim().split("\n")[0].replace(/^["'`]|["'`]$/g, "").trim();
  return title ? title.slice(0, 72) : undefined;
}
