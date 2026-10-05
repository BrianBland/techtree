import { useEffect, useState } from "preact/hooks";
import { ALL_PROJECTS, hasScorer } from "../core/projects.ts";
import type { ApiOverview, ApiState, Bundle, NodeId, Project, Suggestion, Task } from "../types.ts";
import { get, post } from "./api.ts";
import { linkify } from "./linkify.ts";
import { PrRow, Section, SuggestionRow, attentionKey, fmt } from "./Panel.tsx";

export interface OverviewProps {
  state: ApiState;
  /** The selected project id, or "all" for the cross-project overview. */
  view: string;
  projects: Project[];
  /** Bumped when scores change or the event stream reconnects. */
  version: number;
  /** Bumped on every task or PR event of any project. */
  eventTick: number;
  /** Select a node, switching to `project` when given. */
  onSelect(id: NodeId, project?: string): void;
  onStart(suggestion: Suggestion): void;
  onError(message: string): void;
}

export function Overview({ state, view, projects, version, eventTick, onSelect, onStart, onError }: OverviewProps) {
  const [fetched, setFetched] = useState<{ view: string; overview: ApiOverview } | null>(null);
  const all = view === ALL_PROJECTS;

  useEffect(() => {
    let live = true;
    get<ApiOverview>(`/api/overview?project=${encodeURIComponent(view)}`).then(
      (overview) => live && setFetched({ view, overview }),
      (e: Error) => onError(e.message),
    );
    return () => {
      live = false;
    };
  }, [view, attentionKey(state), version, all && eventTick]);

  const overview = fetched?.view === view ? fetched.overview : null;
  if (!overview) return <aside class="panel muted">Loading…</aside>;
  const nodeName = (id: NodeId) => (id === "" ? state.repo.name : id);
  const projectName = (id = state.project.id) => projects.find((p) => p.id === id)?.name ?? id;
  const tag = (id?: string) => all && <span class="project-tag">{projectName(id)}</span>;
  const scored = all || hasScorer(state.project);
  const { coverage } = overview;
  return (
    <aside class="panel">
      <header>
        <div>
          <h2>{all ? "All projects" : projectName()}</h2>
          <div class="muted">
            {state.repo.name} · {state.snapshot ? `scored at ${state.snapshot.sha.slice(0, 8)}` : "not scored yet"}
          </div>
          {!all && state.project.goal && <p class="goal small">{linkify(state.project.goal)}</p>}
        </div>
        {!all && scored && <div class="score-big">{fmt(state.scores[""]?.quality)}</div>}
      </header>
      {!overview.attentionTasks.length && !overview.flaggedPrs.length && <p class="muted">Nothing needs your attention.</p>}
      <Section title="Needs you" items={overview.attentionTasks}>
        {(task) => (
          <li key={task.id} class="row clickable" onClick={() => onSelect(task.node, task.project)}>
            <div>
              {tag(task.project)}
              {task.title}
              <div class="muted small">
                <span class={`state ${task.state}`}>{task.state === "review" ? "ready for review" : "question"}</span> ·{" "}
                {nodeName(task.node)}
              </div>
              {task.question && <div class="small">{linkify(task.question)}</div>}
            </div>
          </li>
        )}
      </Section>
      {stagedByProject(overview.stagedTasks).map(([project, tasks]) => (
        <StagedSection key={project} title={all ? `Staged · ${projectName(project)}` : "Staged"} project={project} tasks={tasks} nodeName={nodeName} onError={onError} />
      ))}
      <Section title="Pull requests needing attention" items={overview.flaggedPrs}>
        {(pr) => <PrRow key={pr.number} pr={pr} tag={tag(pr.project)} onError={onError} />}
      </Section>
      {!scored && (
        <section class="ctas">
          <h3>No scorer yet</h3>
          <p class="small">
            This project has no scorer, so there are no scores or suggestions. Scorers for custom projects are coming in a later update; meanwhile
            select a node and use “New task here” to work toward the goal.
          </p>
        </section>
      )}
      <Section title="Top suggestions" items={overview.suggestions}>
        {(s) => (
          <li key={(s.project ?? "") + s.node + s.title}>
            {tag(s.project)}
            <SuggestionRow suggestion={s} onStart={() => onStart(s)} />
            <button class="link small" onClick={() => onSelect(s.node, s.project)}>
              {nodeName(s.node)}
            </button>
          </li>
        )}
      </Section>
      {scored && (
      <section>
        <h3>Scan coverage</h3>
        <p class="small">
          {coverage.scannedNodes} of {coverage.totalNodes} directories, {pct(coverage.scannedLoc, coverage.totalLoc)} of lines scanned
        </p>
        <div class="meter">
          <div style={{ width: pct(coverage.scannedLoc, coverage.totalLoc) }} />
        </div>
      </section>
      )}
    </aside>
  );
}

function stagedByProject(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) groups.set(task.project, [...(groups.get(task.project) ?? []), task]);
  return [...groups];
}

/** A project's staged tasks with checkboxes and "Open combined PR" (DESIGN "Staging and combined PRs"). */
function StagedSection({ title, project, tasks, nodeName, onError }: { title: string; project: string; tasks: Task[]; nodeName(id: NodeId): string; onError(message: string): void }) {
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [prTitle, setPrTitle] = useState("");
  const [opening, setOpening] = useState(false);
  const taskIds = tasks.filter((t) => !unchecked.has(t.id)).map((t) => t.id);
  const toggle = (id: string) =>
    setUnchecked((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const open = () => {
    setOpening(true);
    post<Bundle>("/api/bundles", { project, taskIds, title: prTitle })
      .then(() => setPrTitle(""), (e: Error) => onError(e.message))
      .finally(() => setOpening(false));
  };
  return (
    <section class="staged-bundle">
      <h3>{title}</h3>
      <ul class="list">
        {tasks.map((task) => (
          <li key={task.id}>
            <label>
              <input type="checkbox" checked={!unchecked.has(task.id)} onChange={() => toggle(task.id)} /> {task.title}
              <span class="muted small"> · {nodeName(task.node)}</span>
            </label>
          </li>
        ))}
      </ul>
      <input type="text" placeholder="PR title (default: from the tasks)" value={prTitle} onInput={(e) => setPrTitle((e.currentTarget as HTMLInputElement).value)} />
      <button class="primary" disabled={!taskIds.length || opening} onClick={open}>
        {opening ? "Opening…" : `Open combined PR (${taskIds.length})`}
      </button>
    </section>
  );
}

function pct(part: number, total: number): string {
  return `${total ? Math.round((part / total) * 100) : 0}%`;
}
