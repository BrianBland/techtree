import { useEffect, useState } from "preact/hooks";
import { QUALITY } from "../core/projects.ts";
import type { ApiPrs, NodeId, PrState, Project, Task } from "../types.ts";
import { get, onReconnect, onServerEvent, post } from "./api.ts";
import { outboxEntry, type OutboxSection } from "./outbox.ts";
import { TaskCard } from "./Panel.tsx";
import { projectColor } from "./Projects.tsx";

export interface OutboxProps {
  projects: Project[];
  version: number;
  /** Select a node, switching to `project`. */
  onSelect(id: NodeId, project: string): void;
  onError(message: string): void;
}

const SECTIONS: [OutboxSection, string][] = [
  ["needs_you", "Needs you"],
  ["babysitting", "Babysitting"],
  ["waiting", "Waiting"],
];

/** The right panel: every open PR, sorted into Needs you / Babysitting / Waiting (DESIGN "Outbox"). */
export function Outbox({ projects, version, onSelect, onError }: OutboxProps) {
  const [data, setData] = useState<ApiPrs | null>(null);

  useEffect(() => {
    const load = () => get<ApiPrs>("/api/prs").then(setData, (e: Error) => onError(e.message));
    void load();
    const stopReconnect = onReconnect(() => void load());
    const stopEvents = onServerEvent((event) => {
      if (event.type === "pr") {
        setData((d) => {
          if (!d) return d;
          if (event.pr.taskId && !d.tasks.some((t) => t.id === event.pr.taskId)) void load();
          return { ...d, prs: upsert(d.prs, event.pr, (p) => p.number) };
        });
      } else if (event.type === "pr_removed") {
        setData((d) => d && { ...d, prs: d.prs.filter((p) => p.number !== event.number) });
      } else if (event.type === "task") {
        setData((d) => (d && d.prs.some((p) => p.taskId === event.task.id) ? { ...d, tasks: upsert(d.tasks, event.task, (t) => t.id) } : d));
      } else if (event.type === "task_removed") {
        setData((d) => d && { ...d, tasks: d.tasks.filter((t) => t.id !== event.taskId) });
      }
    });
    return () => {
      stopReconnect();
      stopEvents();
    };
  }, []);

  if (!data) return <aside class="panel outbox muted">Loading…</aside>;
  const rows = data.prs.map((pr) => {
    const task = data.tasks.find((t) => t.id === pr.taskId);
    return { pr, task, ...outboxEntry(pr, task) };
  });
  const needsYou = rows.filter((r) => r.section === "needs_you").length;
  const toggleAuto = (on: boolean) => post<ApiPrs>("/api/prs/auto-babysit", { on }).then(setData, (e: Error) => onError(e.message));
  return (
    <aside class="panel outbox">
      <header>
        <div>
          <h2>
            Outbox{needsYou > 0 && <span class="needs-count">{needsYou}</span>}
          </h2>
          <div class="muted small">{data.prs.length} open PRs · nothing merges here</div>
        </div>
        <label class="small" title="Babysit every PR of yours, and new ones as they appear">
          <input type="checkbox" checked={data.autoBabysit} onChange={(e) => toggleAuto((e.currentTarget as HTMLInputElement).checked)} /> Auto-babysit
        </label>
      </header>
      {!rows.length && <p class="muted">No open PRs.</p>}
      {SECTIONS.map(([section, title]) => {
        const items = rows.filter((r) => r.section === section);
        if (!items.length) return null;
        return (
          <section key={section}>
            <h3>{title}</h3>
            <ul class="list">
              {items.map((r) => (
                <OutboxRow key={r.pr.number} {...r} prs={data.prs} projects={projects} version={version} onSelect={onSelect} onError={onError} />
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}

interface OutboxRowProps {
  pr: PrState;
  task?: Task;
  section: OutboxSection;
  status: string;
  prs: PrState[];
  projects: Project[];
  version: number;
  onSelect(id: NodeId, project: string): void;
  onError(message: string): void;
}

function OutboxRow({ pr, task, section, status, prs, projects, version, onSelect, onError }: OutboxRowProps) {
  const [open, setOpen] = useState(false);
  const project = pr.project ?? QUALITY;
  const stop = (e: Event) => e.stopPropagation();
  const toggle = (e: Event) =>
    post(`/api/prs/${pr.number}/babysit`, { on: (e.currentTarget as HTMLInputElement).checked }).catch((err: Error) => onError(err.message));
  return (
    <li class={`outbox-row ${section}`}>
      <div class="row clickable" onClick={() => onSelect(pr.node, project)}>
        <div>
          <span class="project-tag" style={{ background: projectColor(projects, project) }}>
            {projects.find((p) => p.id === project)?.name ?? project}
          </span>
          <a href={pr.url} target="_blank" rel="noreferrer" onClick={stop}>
            #{pr.number}
          </a>{" "}
          {pr.title}
          <div class="small">
            <span class={`ci ${pr.ci}`}>CI {pr.ci}</span>
            {pr.review && <span class="muted"> · {pr.review.toLowerCase().replace(/_/g, " ")}</span>}
            {pr.mergeable === "CONFLICTING" && <span class="ci fail"> · conflict</span>}
            <span class="muted"> · {age(pr.updatedAt)}</span>
          </div>
          <div class="small status">{status}</div>
        </div>
        <div class="outbox-controls" onClick={stop}>
          <label class="small">
            <input type="checkbox" checked={pr.babysit} onChange={toggle} /> babysit
          </label>
          {task && (
            <button class="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "▾ task" : "▸ task"}
            </button>
          )}
        </div>
      </div>
      {open && task && (
        <ul class="list">
          <TaskCard task={task} prs={prs} scorer={{}} version={version} onError={onError} />
        </ul>
      )}
    </li>
  );
}

function age(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function upsert<T>(items: T[], item: T, key: (item: T) => string | number): T[] {
  const index = items.findIndex((x) => key(x) === key(item));
  return index < 0 ? [...items, item] : items.map((x, i) => (i === index ? item : x));
}
