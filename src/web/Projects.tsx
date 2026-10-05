import { useState } from "preact/hooks";
import { ALL_PROJECTS, QUALITY } from "../core/projects.ts";
import type { Project } from "../types.ts";
import { send } from "./api.ts";

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

/** Header project picker ("All projects", "New project…") with a settings gear for the selected project. */
export function ProjectSwitcher({ projects, view, onSwitch, onChanged, onError }: ProjectSwitcherProps) {
  const [dialog, setDialog] = useState<"new" | "settings" | null>(null);
  const current = projects.find((p) => p.id === view);
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
      <select class="project-switcher" value={view} onChange={choose} title="Project">
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={ALL_PROJECTS}>All projects</option>
        <option value={NEW_PROJECT}>New project…</option>
      </select>
      <button class="link" title="Project settings" disabled={!current} onClick={() => setDialog("settings")}>
        ⚙
      </button>
      {dialog === "new" && <ProjectDialog onDone={done} onClose={() => setDialog(null)} onError={onError} />}
      {dialog === "settings" && current && <ProjectDialog project={current} onDone={done} onClose={() => setDialog(null)} onError={onError} />}
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
  const editsScorer = project && !project.builtin;
  const submit = (e: Event) => {
    e.preventDefault();
    const scorer = { rubric, command: command.split("\n").map((arg) => arg.trim()).filter(Boolean), plan };
    const saved = project
      ? send<Project>("PATCH", `/api/projects/${encodeURIComponent(project.id)}`, { name, goal, ...(editsScorer && { scorer }) })
      : send<Project>("POST", "/api/projects", { name, goal });
    saved.then((p) => onDone(p.id), (err: Error) => onError(err.message));
  };
  const remove = () => {
    if (!project || !confirm(`Delete project ${project.name} with its tasks?`)) return;
    send("DELETE", `/api/projects/${encodeURIComponent(project.id)}`).then(() => onDone(QUALITY), (err: Error) => onError(err.message));
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
        {editsScorer && (
          <>
            <label>
              Rubric
              <textarea
                rows={4}
                value={rubric}
                placeholder="What an LLM scan should look for, e.g. allocation-heavy hot paths"
                onInput={(e) => setRubric((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </label>
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
          {project && !project.builtin && (
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
