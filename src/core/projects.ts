import type { Db } from "../db.ts";
import type { Project } from "../types.ts";

/** Id of the built-in Quality project, the default of every project-scoped route and column. */
export const QUALITY = "quality";
/** Reserved id of the cross-project overview. */
export const ALL_PROJECTS = "all";

export const QUALITY_PROJECT: Project = {
  id: QUALITY,
  name: "Quality",
  scorer: { plugins: ["generic", "git", "rust", "slop", "llm-scan"] },
  createdAt: "1970-01-01T00:00:00.000Z",
  builtin: true,
};

/** Whether the project is scored (DESIGN "Projects": a non-empty `scorer.plugins`). */
export function hasScorer(project: Project): boolean {
  return !!project.scorer.plugins?.length;
}

/** Every project, Quality first, then by creation. */
export function listProjects(db: Db): Project[] {
  const rows = db.prepare("SELECT data FROM projects").all() as { data: string }[];
  return rows
    .map((r) => JSON.parse(r.data) as Project)
    .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || a.createdAt.localeCompare(b.createdAt));
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
  for (const table of ["findings", "snapshots", "tasks", "projects"]) {
    db.prepare(`DELETE FROM ${table} WHERE ${table === "projects" ? "id" : "project"} = ?`).run(id);
  }
}
