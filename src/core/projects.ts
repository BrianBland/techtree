import type { Db } from "../db.ts";
import type { Project, ScorerSpec } from "../types.ts";

/** Default project id for project-scoped routes and legacy rows. */
export const QUALITY = "quality";
/** Reserved id of the cross-project overview. */
export const ALL_PROJECTS = "all";
export const SCORER_PLUGINS = ["generic", "git", "rust", "slop", "llm-scan"] as const;

export const QUALITY_PROJECT: Project = {
  id: QUALITY,
  name: "Quality",
  scorer: { plugins: [...SCORER_PLUGINS] },
  createdAt: "1970-01-01T00:00:00.000Z",
};

/** Whether a project selects metric plugins. */
export function hasScorer(project: Project): boolean {
  return !!project.scorer.plugins?.length;
}

/** Whether the project has any scorer: plugins, a rubric, a command or a plan (DESIGN "Projects"). */
export function isScored(project: Project): boolean {
  const { rubric, command, plan } = project.scorer;
  return hasScorer(project) || !!rubric?.trim() || !!command?.length || !!plan;
}

/** Whether the project has a rubric or explicitly selects the default LLM scan. */
export function isScannable(project: Project): boolean {
  return !!project.scorer.rubric?.trim() || !!project.scorer.plugins?.includes("llm-scan");
}

/**
 * The validated parts of an untrusted scorer, or an error message.
 * Blank rubric, empty plugin/command lists and false plan are dropped.
 */
export function scorerParts(value: unknown): ScorerSpec | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "scorer must be an object";
  const { plugins, rubric, command, plan, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return `unknown scorer fields: ${Object.keys(rest).join(", ")}`;
  if (plugins !== undefined && !(Array.isArray(plugins) && plugins.every((id) => typeof id === "string" && SCORER_PLUGINS.includes(id as typeof SCORER_PLUGINS[number])))) return "scorer.plugins must list known plugin ids";
  if (Array.isArray(plugins) && plugins.includes("slop") && !plugins.includes("rust")) return "scorer.plugins: slop requires rust for test counts";
  if (rubric !== undefined && typeof rubric !== "string") return "scorer.rubric must be a string";
  if (command !== undefined && !(Array.isArray(command) && command.every((a) => typeof a === "string"))) return "scorer.command must be a list of strings";
  if (plan !== undefined && typeof plan !== "boolean") return "scorer.plan must be a boolean";
  return {
    ...(Array.isArray(plugins) && plugins.length && { plugins: [...new Set(plugins as string[])] }),
    ...(rubric?.trim() && { rubric: rubric.trim() }),
    ...(command?.length && { command }),
    ...(plan && { plan }),
  };
}

/** Every project, ordered by creation. */
export function listProjects(db: Db): Project[] {
  const rows = db.prepare("SELECT data FROM projects").all() as { data: string }[];
  return rows
    .map((r) => JSON.parse(r.data) as Project)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProject(db: Db, id: string): Project | undefined {
  const row = db.prepare("SELECT data FROM projects WHERE id = ?").get(id) as { data: string } | undefined;
  return row && (JSON.parse(row.data) as Project);
}

export function saveProject(db: Db, project: Project): void {
  db.prepare("INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data").run(
    project.id,
    JSON.stringify(project),
  );
}

/** A new custom project with an empty scorer, its id derived from the name (DESIGN "Projects"). */
export function createProject(db: Db, name: string, goal?: string): Project {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  let id = base;
  for (let n = 2; id === ALL_PROJECTS || getProject(db, id); n++) id = `${base}-${n}`;
  const project: Project = { id, name, ...(goal && { goal }), scorer: {}, createdAt: new Date().toISOString() };
  saveProject(db, project);
  return project;
}

/** Delete a project with its findings, snapshots and task rows (the caller discards the tasks first). */
export function deleteProjectRows(db: Db, id: string): void {
  for (const table of ["findings", "snapshots", "tasks", "dismissals", "projects"]) {
    db.prepare(`DELETE FROM ${table} WHERE ${table === "projects" ? "id" : "project"} = ?`).run(id);
  }
}
