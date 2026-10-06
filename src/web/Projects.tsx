import { useState } from "preact/hooks";
import { ALL_PROJECTS, SCORER_PLUGINS } from "../core/projects.ts";
import type { Project } from "../types.ts";
import { get, send } from "./api.ts";

const NEW_PROJECT = "__new";

export interface ProjectSwitcherProps {
  projects: Project[];
  /** The selected project id, or "all". */
  view: string;
  onSwitch(view: string): void;
  /** Called after a project was created, changed or deleted, with the view to show next. */
  onChanged(view: string): void;
  onError(message: string): void;
}

const PALETTE = ["#d9a441", "#4fa3d9", "#d95f8e", "#5fbf6a", "#a07ad9", "#e07b39", "#3fbfb0", "#c9c94a"];

/** The colour of project `id`, by its position in `projects` (DESIGN "Project colours"). */
export function projectColor(projects: Project[], id: string): string {
  const index = projects.findIndex((p) => p.id === id);
  return PALETTE[Math.max(index, 0) % PALETTE.length];
}

/** Header project picker ("All projects", "New project…") with a settings gear for the selected project. */
export function ProjectSwitcher({ projects, view, onSwitch, onChanged, onError }: ProjectSwitcherProps) {
  const [dialog, setDialog] = useState<"new" | "settings" | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const current = projects.find((p) => p.id === view);
  const openSettings = () =>
    get<Project[]>("/api/projects").then((list) => {
      const fresh = list.find((p) => p.id === view);
      if (!fresh) return onError(`no project ${view}`);
      setEditing(fresh);
      setDialog("settings");
    }, (err: Error) => onError(err.message));
  const choose = (e: Event) => {
    const select = e.currentTarget as HTMLSelectElement;
    if (select.value === NEW_PROJECT) {
      select.value = view;
      setDialog("new");
    } else onSwitch(select.value);
  };
  const done = (next: string) => {
    setDialog(null);
    onChanged(next);
  };
  return (
    <>
      <select class="project-switcher" value={view} onChange={choose} title="Project" style={current ? { borderLeft: `6px solid ${projectColor(projects, current.id)}` } : undefined}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={ALL_PROJECTS}>All projects</option>
        <option value={NEW_PROJECT}>New project…</option>
      </select>
      <button class="link" title="Project settings" disabled={!current} onClick={openSettings}>
        ⚙
      </button>
      {dialog === "new" && <ProjectDialog onDone={done} onClose={() => setDialog(null)} onError={onError} />}
      {dialog === "settings" && editing && <ProjectDialog project={editing} onDone={done} onClose={() => setDialog(null)} onError={onError} />}
    </>
  );
}

interface ProjectDialogProps {
  /** The project to edit; without one the dialog creates a project. */
  project?: Project;
  onDone(view: string): void;
  onClose(): void;
  onError(message: string): void;
}

function ProjectDialog({ project, onDone, onClose, onError }: ProjectDialogProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [goal, setGoal] = useState(project?.goal ?? "");
  const [rubric, setRubric] = useState(project?.scorer.rubric ?? "");
  const [command, setCommand] = useState(project?.scorer.command?.join("\n") ?? "");
  const [plan, setPlan] = useState(!!project?.scorer.plan);
  const [plugins, setPlugins] = useState(project?.scorer.plugins ?? []);
  const editsScorer = !!project;
  const submit = (e: Event) => {
    e.preventDefault();
    const scorer = { plugins, rubric, command: command.split("\n").map((arg) => arg.trim()).filter(Boolean), plan };
    const saved = project
      ? send<Project>("PATCH", `/api/projects/${encodeURIComponent(project.id)}`, { name, goal, ...(editsScorer && { scorer }) })
      : send<Project>("POST", "/api/projects", { name, goal });
    saved.then((p) => onDone(p.id), (err: Error) => onError(err.message));
  };
  const remove = () => {
    if (!project || !confirm(`Delete project ${project.name} with its tasks?`)) return;
    send("DELETE", `/api/projects/${encodeURIComponent(project.id)}`).then(() => onDone(ALL_PROJECTS), (err: Error) => onError(err.message));
  };
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="dialog project-dialog" onSubmit={submit}>
        <h3>{project ? "Project settings" : "New project"}</h3>
        <label>
          Name
          <input value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label>
          Goal
          <textarea
            rows={5}
            value={goal}
            placeholder="What should this project achieve? Workers see it with every task."
            onInput={(e) => setGoal((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </label>
        <RefineButton kind="goal" text={goal} name={name} onText={setGoal} onError={onError} />
        {editsScorer && (
          <>
            <fieldset>
              <legend>Metric plugins</legend>
              {SCORER_PLUGINS.map((id) => (
                <label class="inline" key={id}>
                  <input type="checkbox" checked={plugins.includes(id)} onChange={(e) => setPlugins((e.currentTarget as HTMLInputElement).checked ? [...plugins, id] : plugins.filter((p) => p !== id))} />
                  {id}
                </label>
              ))}
            </fieldset>
            <p class="muted small">Slop requires Rust for test-count normalization.</p>
            <label>
              Rubric
              <textarea
                rows={4}
                value={rubric}
                placeholder="What an LLM scan should look for, e.g. allocation-heavy hot paths"
                onInput={(e) => setRubric((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </label>
            <RefineButton kind="rubric" text={rubric} name={name} goal={goal} onText={setRubric} onError={onError} />
            <label>
              Command (one argument per line)
              <textarea
                rows={3}
                value={command}
                placeholder={"node\n/path/to/score.mjs"}
                onInput={(e) => setCommand((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </label>
            <label class="inline">
              <input type="checkbox" checked={plan} onChange={(e) => setPlan((e.currentTarget as HTMLInputElement).checked)} />
              Plan: score progress on work items
            </label>
          </>
        )}
        <div class="buttons">
          {project && (
            <button type="button" class="link danger" onClick={remove}>
              Delete
            </button>
          )}
          <button type="button" class="link" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={!name.trim()}>
            {project ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** "Refine with agent" for a goal or rubric field, with Undo (DESIGN "Refining text"). */
function RefineButton({ kind, text, name, goal, onText, onError }: { kind: "goal" | "rubric"; text: string; name: string; goal?: string; onText(text: string): void; onError(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const refine = () => {
    setBusy(true);
    send<{ text: string }>("POST", "/api/refine", { kind, text, name, ...(goal && { goal }) })
      .then((r) => {
        setPrevious(text);
        onText(r.text);
      }, (e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div class="refine">
      <button type="button" disabled={busy || !text.trim()} onClick={refine} title="Rewrite this text with an agent (uses refineModel)">
        {busy ? "Refining…" : "Refine with agent"}
      </button>
      {previous !== null && !busy && (
        <button type="button" class="link" onClick={() => (onText(previous), setPrevious(null))}>
          Undo
        </button>
      )}
    </div>
  );
}
