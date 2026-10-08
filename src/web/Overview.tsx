import { useEffect, useState } from "preact/hooks";
import { ALL_PROJECTS, isScannable, isScored } from "../core/projects.ts";
import type { ApiComposition, ApiOverview, ApiState, Bundle, BundleJob, NodeId, Project, StartTaskRequest, Suggestion, Task, TaskKind } from "../types.ts";
import { get, onReconnect, onServerEvent, post } from "./api.ts";
import { linkify } from "./linkify.ts";
import { projectColor } from "./Projects.tsx";
import { Section, SuggestionRow, attentionKey, fmt } from "./Panel.tsx";

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
    let request = 0;
    const load = () => {
      const latest = ++request;
      return get<ApiOverview>(`/api/overview?project=${encodeURIComponent(view)}`).then(
        (overview) => live && latest === request && setFetched({ view, overview }),
        (e: Error) => live && latest === request && onError(e.message),
      );
    };
    void load();
    const stop = onServerEvent((event) => {
      if (event.type === "composition" && (all || event.composition.project === view)) void load();
    });
    return () => { live = false; stop(); };
  }, [view, attentionKey(state), version, all && eventTick]);

  const [projectTask, setProjectTask] = useState<{ kind: TaskKind; title: string; project: string } | null>(null);
  const overview = fetched?.view === view ? fetched.overview : null;
  if (!overview) return <aside class="panel muted">Loading…</aside>;
  const nodeName = (id: NodeId) => (id === "" ? state.repo.name : id);
  const projectName = (id = state.project.id) => projects.find((p) => p.id === id)?.name ?? id;
  const tag = (id = state.project.id) =>
    all && (
      <span class="project-tag" style={{ background: projectColor(projects, id) }}>
        {projectName(id)}
      </span>
    );
  const scored = all || isScored(state.project);
  const custom = !all;
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
      {!overview.attentionTasks.length && <p class="muted">Nothing needs your attention.</p>}
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
      <Section title="In progress" items={overview.activeTasks}>
        {(task) => {
          const done = task.checklist.filter((c) => c.done).length;
          return (
            <li key={task.id} class="row clickable" onClick={() => onSelect(task.node, task.project)}>
              <div>
                {tag(task.project)}
                {task.title}
                <div class="muted small">
                  <span class={`state ${task.state}`}>{task.state}</span>
                  {task.checklist.length > 0 && ` · ${done}/${task.checklist.length} steps`} · {nodeName(task.node)}
                </div>
              </div>
            </li>
          );
        }}
      </Section>
      {(all ? projects.map((p) => p.id) : [state.project.id]).map((project) => (
        <StagedSection
          key={project}
          title={all ? `Staged · ${projectName(project)}` : "Staged"}
          project={project}
          tasks={overview.stagedTasks.filter((t) => t.project === project)}
          nodeName={nodeName}
          onError={onError}
        />
      ))}
      {overview.scorerErrors?.map((e) => (
        <p key={e} class="error small">
          Scorer failed: {linkify(e)}
        </p>
      ))}
      {custom && (
        <section class="ctas">
          <h3>{scored ? "Scorer" : "No scorer yet"}</h3>
          {!scored && <p class="small">Draft a scorer to measure progress toward the goal, or plan the work as items to track.</p>}
          <div class="actions">
            <button onClick={() => setProjectTask({ kind: "scorer", title: scored ? "Refine scorer" : "Draft scorer", project: state.project.id })}>
              {scored ? "Refine scorer" : "Draft scorer"}
            </button>
            {(!scored || state.project.scorer.plan) && (
              <button onClick={() => setProjectTask({ kind: "plan", title: "Plan the work", project: state.project.id })}>Plan the work</button>
            )}
          </div>
        </section>
      )}
      <Section title="Projects without a scorer" items={all ? projects.filter((p) => !isScored(p)) : []}>
        {(p) => (
          <li key={p.id} class="row">
            <div>
              <span class="project-tag">{p.name}</span>
            </div>
            <div class="actions">
              <button onClick={() => setProjectTask({ kind: "scorer", title: "Draft scorer", project: p.id })}>Draft scorer</button>
              <button onClick={() => setProjectTask({ kind: "plan", title: "Plan the work", project: p.id })}>Plan the work</button>
            </div>
          </li>
        )}
      </Section>
      {projectTask && <ProjectTaskDialog {...projectTask} onClose={() => setProjectTask(null)} onError={onError} />}
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
      {(all || isScannable(state.project)) && (
      <section>
        <h3>Scan coverage</h3>
        <p class="small">
          {coverage.scannedNodes} of {coverage.totalNodes} directories, {pct(coverage.scannedLoc, coverage.totalLoc)} of lines scanned
        </p>
        <div class="meter">
          <div style={{ width: pct(coverage.scannedLoc, coverage.totalLoc) }} />
        </div>
        {!all && (
          <button onClick={() => post(`/api/scan?project=${encodeURIComponent(view)}`, { node: "" }).catch((e: Error) => onError(e.message))}>Scan repo</button>
        )}
      </section>
      )}
    </aside>
  );
}

/** Start a scorer or plan task with an optional instruction (DESIGN "Task kinds"). */
function ProjectTaskDialog({ kind, title, project, onClose, onError }: { kind: TaskKind; title: string; project: string; onClose(): void; onError(message: string): void }) {
  const [instruction, setInstruction] = useState("");
  const submit = (e: Event) => {
    e.preventDefault();
    const request: StartTaskRequest = { node: "", findingIds: [], manualReview: false, kind, project, ...(instruction.trim() && { prompt: instruction }) };
    onClose();
    post("/api/tasks", request).catch((err: Error) => onError(err.message));
  };
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="dialog" onSubmit={submit}>
        <h3>{title}</h3>
        <label>
          Instruction (optional)
          <textarea rows={5} value={instruction} onInput={(e) => setInstruction((e.currentTarget as HTMLTextAreaElement).value)} />
        </label>
        <div class="buttons">
          <button type="button" class="link" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary">
            Start
          </button>
        </div>
      </form>
    </div>
  );
}

/** A project's smart grouping state, kept current by `composition` events. */
function useComposition(project: string, onError: (message: string) => void): [ApiComposition | null, (c: ApiComposition) => void] {
  const [composition, setComposition] = useState<ApiComposition | null>(null);
  const update = (incoming: ApiComposition) => setComposition((current) => {
    // An acceptance response or reconnect fetch can arrive after a newer job event.
    const jobs = new Map((current?.bundleJobs ?? []).map((job) => [job.id, job]));
    for (const job of incoming.bundleJobs ?? []) {
      if ((jobs.get(job.id)?.revision ?? -1) <= job.revision) jobs.set(job.id, job);
    }
    let terminal = 0;
    const bundleJobs = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((job) => job.status === "queued" || job.status === "running" || terminal++ < 20);
    return { ...incoming, bundleJobs };
  });
  useEffect(() => {
    let live = true;
    const load = () => get<ApiComposition>(`/api/composition?project=${encodeURIComponent(project)}`).then((c) => live && update(c), (e: Error) => live && onError(e.message));
    void load();
    const stopEvents = onServerEvent((e) => {
      if (e.type === "composition" && e.composition.project === project) update(e.composition);
    });
    const stopReconnect = onReconnect(() => void load());
    return () => {
      live = false;
      stopEvents();
      stopReconnect();
    };
  }, [project]);
  return [composition, update];
}

/**
 * A project's unchecked staged tasks, visual smart-group suggestions and manual combined publication;
 * and the open stacks (DESIGN "Staging and combined PRs", "Smart PR composition").
 */
function StagedSection({ title, project, tasks, nodeName, onError }: { title: string; project: string; tasks: Task[]; nodeName(id: NodeId): string; onError(message: string): void }) {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [prTitle, setPrTitle] = useState("");
  const [opening, setOpening] = useState(false);
  const [publicationError, setPublicationError] = useState("");
  const [composition, setComposition] = useComposition(project, onError);
  const jobs = composition?.bundleJobs ?? [];
  const pending = new Set(jobs.filter((job) => job.status === "queued" || job.status === "running").flatMap((job) => job.taskIds));
  const available = tasks.filter((task) => !pending.has(task.id));
  // Staging generations make an unstaged/re-staged task unchecked without synchronizing props into state.
  const selectionKey = (task: Task) => `${task.id}:${task.stagedAt ?? ""}`;
  const checked = new Set(available.filter((task) => selection.has(selectionKey(task))).map((task) => task.id));
  const proposedIds = composition?.proposal?.groups.flatMap((group) => group.taskIds) ?? [];
  const showGroups = !!composition?.proposal && !composition.proposal.stale && proposedIds.length === available.length && available.every((task) => proposedIds.includes(task.id));
  const badges = new Map<string, { number: number; rationale: string }>();
  let groupNumber = 0;
  const orderedTasks = showGroups ? composition!.proposal!.groups.flatMap((group) => {
    const badge = group.taskIds.length > 1 ? { number: ++groupNumber, rationale: group.rationale } : undefined;
    return group.taskIds.map((id) => {
      if (badge) badges.set(id, badge);
      return available.find((task) => task.id === id)!;
    });
  }) : available;
  if (!available.length && !composition?.stacks.length && !composition?.lastResult && !jobs.length && !publicationError) return null;
  const taskIds = available.filter((t) => checked.has(t.id)).map((t) => t.id);
  const toggle = (id: string) => {
    const task = available.find((task) => task.id === id);
    if (!task) return;
    const key = selectionKey(task);
    setSelection((ids) => {
      const next = new Set(ids);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const open = () => {
    setOpening(true);
    setPublicationError("");
    const submitted = new Set(available.filter((task) => checked.has(task.id)).map(selectionKey));
    post<ApiComposition>("/api/bundles/start", { project, taskIds, title: prTitle })
      .then((accepted) => {
        setComposition(accepted); setPrTitle("");
        setSelection((ids) => new Set([...ids].filter((key) => !submitted.has(key))));
      }, (e: Error) => { setPublicationError(e.message); onError(e.message); })
      .finally(() => setOpening(false));
  };
  return (
    <section class="staged-bundle">
      <h3>{title}</h3>
      {composition && available.length > 0 && <SmartGroup composition={composition} showGroups={showGroups} onChange={setComposition} onError={onError} />}
      <PublicationJobs jobs={jobs} />
      {publicationError && <p class="publication-error" role="alert">{publicationError}</p>}
      {composition?.lastResult && (
        <p class={`small${composition.lastResult.error ? " error" : ""}`}>
          Opened {composition.lastResult.bundleIds.length} PRs{composition.lastResult.error ? `; stopped: ${composition.lastResult.error}` : "."}
        </p>
      )}
      {available.length > 0 && (
        <>
          <p class="muted small">Select any changes—even across badges—to open one PR. Badges are AI suggestions only.</p>
          <input type="text" placeholder="PR title (default: from the tasks)" value={prTitle} onInput={(e) => setPrTitle((e.currentTarget as HTMLInputElement).value)} />
          <div class="actions">
            <button class="primary" disabled={!taskIds.length || opening || composition?.status === "publishing"} onClick={open}>
              {opening ? "Submitting…" : `Open combined PR (${taskIds.length})`}
            </button>
            <button class="link" disabled={!taskIds.length || opening} onClick={() => setSelection(new Set())}>Clear selection</button>
          </div>
          <StagedTasks tasks={orderedTasks} badges={badges} checked={checked} toggle={toggle} nodeName={nodeName} />
        </>
      )}
      {composition && composition.stacks.length > 0 && <Stacks stacks={composition.stacks} />}
    </section>
  );
}

function PublicationJobs({ jobs }: { jobs: BundleJob[] }) {
  if (!jobs.length) return null;
  return <section class="publication-jobs" aria-label="PR opening activity">
    <h4>PR opening activity</h4>
    <ul class="list small">{jobs.map((job) => <li key={job.id}>
      <strong>{job.status === "queued" ? "Queued" : job.status === "running" ? "Opening PR in background" : job.status === "opened" ? "Opened PR" : job.status === "interrupted" ? "Opening interrupted" : "Opening failed"}</strong>
      {job.bundle && <> <a href={job.bundle.url} target="_blank" rel="noreferrer">#{job.bundle.pr}</a></>}
      <div>{job.taskTitles.join(" · ")}</div>
      {job.error && <p class="error" role="alert">{job.error}</p>}
    </li>)}</ul>
  </section>;
}

function StagedTasks({ tasks, badges, checked, toggle, nodeName }: { tasks: Task[]; badges: Map<string, { number: number; rationale: string }>; checked: Set<string>; toggle(id: string): void; nodeName(id: NodeId): string }) {
  return (
    <ul class="list staged-tasks">
      {tasks.map((task) => {
        const badge = badges.get(task.id);
        return (
        <li key={task.id}>
          <label>
            <input type="checkbox" checked={checked.has(task.id)} onChange={() => toggle(task.id)} />{" "}
            {badge && <span class="group-badge" title={badge.rationale} style={{ color: `hsl(${badge.number * 137.508 % 360} 65% 75%)` }}>Group {badge.number}</span>}
            {task.title}
            <span class="muted small"> · {nodeName(task.node)}</span>
          </label>
        </li>
        );
      })}
    </ul>
  );
}

function SmartGroup({ composition, showGroups, onChange, onError }: { composition: ApiComposition; showGroups: boolean; onChange(c: ApiComposition): void; onError(message: string): void }) {
  const { project, proposal, status } = composition;
  const query = `?project=${encodeURIComponent(project)}`;
  const call = (path: string, body: object = {}) => post<ApiComposition>(path, body).then(onChange, (e: Error) => onError(e.message));
  const busy = status === "planning" || status === "publishing";
  const note =
    status === "planning" ? "Grouping…"
    : status === "queued" ? "Grouping shortly…"
    : status === "publishing" ? "Publishing…"
    : proposal && !showGroups ? "The staged tasks changed since these suggestions; group again."
    : composition.auto && !composition.model ? "Automatic grouping needs groupModel or titleModel in the config; Smart group uses pi's default model."
    : "";
  return (
    <div class="smart-group">
      <div class="actions">
        <button disabled={busy} onClick={() => call(`/api/composition/plan${query}`)}>
          Smart group
        </button>
        <label class="small">
          <input type="checkbox" checked={composition.auto} onChange={(e) => call(`/api/composition/auto${query}`, { on: (e.currentTarget as HTMLInputElement).checked })} /> Group automatically
        </label>
      </div>
      {note && <p class="muted small">{note}</p>}
      {composition.error && <p class="error small">{composition.error}</p>}
    </div>
  );
}

/** Open smart stacks: each PR with the PR (or base branch) it targets. */
function Stacks({ stacks }: { stacks: Bundle[] }) {
  return (
    <ul class="list small">
      {stacks.map((b) => (
        <li key={b.id}>
          <a href={b.url} target="_blank" rel="noreferrer">
            #{b.pr}
          </a>{" "}
          {b.title} → {b.parent ? `#${stacks.find((p) => p.id === b.parent)?.pr ?? b.parent}` : b.base}
        </li>
      ))}
    </ul>
  );
}

function pct(part: number, total: number): string {
  return `${total ? Math.round((part / total) * 100) : 0}%`;
}
