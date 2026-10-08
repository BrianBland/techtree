import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ALL_PROJECTS, QUALITY } from "../core/projects.ts";
import type { ApiState, Finding, NodeId, Project, Suggestion } from "../types.ts";
import { get, onReconnect, onServerEvent, post } from "./api.ts";
import { focusView, layoutTree, siblingOrder, stubId, toggleOverride, type Overrides, type SortKey } from "./layout.ts";
import { activeNodes, attentionNodes, COMPOSITE, ramp, scoreDeltas, scoredTree, scoreValue, sqrtScale, statMetrics, subtreeValues, tileLooks, tileSize } from "./visual.ts";
import { TreeView } from "./TreeView.tsx";
import { GroupContext, NodePanel, StartDialog } from "./Panel.tsx";
import { combineSuggestions, toggleSuggestion } from "./group.ts";
import { Overview } from "./Overview.tsx";
import { INBOX_WIDTH, OUTBOX_WIDTH, PanelResizer, usePanelWidth } from "./PanelResizer.tsx";
import { Outbox } from "./Outbox.tsx";
import { ProjectSwitcher } from "./Projects.tsx";

function App() {
  const [view, setView] = useState(initialView);
  const [treeProject, setTreeProject] = useState(view === ALL_PROJECTS ? QUALITY : view);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [state, setState] = useState<ApiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [eventTick, setEventTick] = useState(0);
  const shownProject = useRef(treeProject);
  const loadGeneration = useRef(0);
  shownProject.current = treeProject;

  const load = () => {
    const project = shownProject.current;
    const generation = ++loadGeneration.current;
    return get<ApiState>(`/api/state?project=${encodeURIComponent(project)}`).then(
      (s) => generation === loadGeneration.current && project === shownProject.current && setState(s),
      (e: Error) => setError(e.message),
    );
  };
  const loadProjects = () => get<Project[]>("/api/projects").then((list) => {
    setProjects(list);
    setProjectsLoaded(true);
    if (!list.some((p) => p.id === shownProject.current)) {
      ++loadGeneration.current;
      setState(null);
      setError(null);
      const next = list[0]?.id ?? QUALITY;
      shownProject.current = next;
      setTreeProject(next);
      setView((v) => v === ALL_PROJECTS ? v : next);
    }
    return list;
  }, (e: Error) => setError(e.message));

  const resync = () => void load().then(() => setVersion((v) => v + 1));

  const switchView = (next: string) => {
    setView(next);
    if (next !== ALL_PROJECTS) setTreeProject(next);
  };

  useEffect(() => { if (projectsLoaded && projects.length) void load(); }, [treeProject, projectsLoaded]);

  useEffect(() => {
    void loadProjects();
    const stopReconnect = onReconnect(() => {
      void loadProjects();
      resync();
    });
    const stopEvents = onServerEvent((event) => {
      if (event.type === "task") {
        setEventTick((n) => n + 1);
        if (event.task.project === shownProject.current) setState((s) => s && { ...s, tasks: upsert(s.tasks, event.task, (t) => t.id) });
        if (event.task.project === shownProject.current) void load();
      } else if (event.type === "pr") {
        setEventTick((n) => n + 1);
        const ours = (event.pr.project ?? QUALITY) === shownProject.current;
        setState((s) => s && { ...s, prs: ours ? upsert(s.prs, event.pr, (p) => p.number) : s.prs.filter((p) => p.number !== event.pr.number) });
      } else if (event.type === "task_removed") {
        setEventTick((n) => n + 1);
        setState((s) => s && { ...s, tasks: s.tasks.filter((t) => t.id !== event.taskId) });
        void load();
      } else if (event.type === "pr_removed") {
        setEventTick((n) => n + 1);
        setState((s) => s && { ...s, prs: s.prs.filter((p) => p.number !== event.number) });
      } else if (event.type === "scores") {
        void loadProjects();
        resync();
      } else if (event.type === "scan") {
        setNotice(`Scan of ${event.node || "repo"}: ${event.status}${event.message ? ` (${event.message})` : ""}`);
      }
    });
    return () => {
      stopReconnect();
      stopEvents();
    };
  }, []);

  const onProjectsChanged = (next: string) =>
    void loadProjects().then(() => {
      switchView(next);
      if (next === shownProject.current) void load();
    });
  if (projectsLoaded && !projects.length) return (
    <div class="loading">
      <p>No projects. Create one to get started.</p>
      <ProjectSwitcher projects={projects} view={ALL_PROJECTS} onSwitch={switchView} onChanged={onProjectsChanged} onError={setError} />
      {error && <p>{error}</p>}
    </div>
  );
  if (!state) return <div class="loading">{error ?? "Loading…"}</div>;
  return (
    <Main
      state={state}
      view={view}
      projects={projects}
      version={version}
      eventTick={eventTick}
      error={error}
      notice={notice}
      setError={setError}
      onSwitch={switchView}
      onProjectsChanged={onProjectsChanged}
    />
  );
}

interface MainProps {
  state: ApiState;
  /** The selected project id, or "all" (the tree then shows `state.project`). */
  view: string;
  projects: Project[];
  version: number;
  /** Bumped on every task or PR event of any project, for the cross-project overview. */
  eventTick: number;
  error: string | null;
  notice: string | null;
  setError(message: string | null): void;
  onSwitch(view: string): void;
  onProjectsChanged(view: string): void;
}

function Main({ state, view, projects, version, eventTick, error, notice, setError, onSwitch, onProjectsChanged }: MainProps) {
  const [scoreKey, setScoreKey] = useState(COMPOSITE);
  const [weightKey, setWeightKey] = useState("loc");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [prioritizeActive, setPrioritizeActive] = useState(true);
  const [hideUnscored, setHideUnscored] = useState(false);
  const [focus, setFocus] = useState<NodeId>(() => initialFocus(state));
  const [selected, setSelected] = useState<NodeId | null>(focus || null);
  const [overrides, setOverrides] = useState<Overrides>(new Map());
  const [fitRequest, setFitRequest] = useState(0);
  const [panelWidth, setPanelWidth] = usePanelWidth(INBOX_WIDTH);
  const [outboxWidth, setOutboxWidth] = usePanelWidth(OUTBOX_WIDTH);
  const refit = () => setFitRequest((n) => n + 1);
  const [starting, setStarting] = useState<{ suggestion: Suggestion; findings: Finding[]; project: string } | null>(null);
  const [grouped, setGrouped] = useState<Suggestion[]>([]);
  const { tree, scores, metricDefs } = state;

  const scoreOf = useCallback((id: NodeId) => scoreValue(scores[id], scoreKey), [scores, scoreKey]);
  const weightOf = useCallback((id: NodeId) => scores[id]?.metrics[weightKey]?.raw ?? 0, [scores, weightKey]);
  const maxWeight = useMemo(() => weightOf(""), [weightOf]);
  const radius = useMemo(() => {
    const side = tileSize(maxWeight);
    return (id: NodeId) => side(weightOf(id)) / 2;
  }, [weightOf, maxWeight]);
  const edgeWidth = useMemo(() => {
    const scale = sqrtScale(maxWeight, 2, 8);
    return (id: NodeId) => Math.round(scale(weightOf(id)));
  }, [weightOf, maxWeight]);

  const sortBasis = sortKey === "score" ? scoreOf : sortKey === "weight" ? weightOf : null;
  const order = useMemo(() => siblingOrder(sortKey, scoreOf, weightOf), [sortKey, sortBasis]);
  const attention = useMemo(() => attentionNodes(state.tasks, state.prs), [state.tasks, state.prs]);
  const active = useMemo(() => activeNodes(state.tasks, state.prs), [state.tasks, state.prs]);
  const values = useMemo(() => subtreeValues(state, prioritizeActive), [tree, scores, state.tasks, state.prs, state.findingCounts, prioritizeActive]);
  const liveFocus = Object.hasOwn(tree.nodes, focus) ? focus : "";
  const graphTree = useMemo(() => hideUnscored ? scoredTree(tree, scoreOf, liveFocus) : tree, [tree, hideUnscored, scoreOf, liveFocus]);
  const shown = useMemo(
    () => focusView({ tree: graphTree, focus: liveFocus, order, overrides, attention, active, prioritizeActive, values }),
    [graphTree, liveFocus, order, overrides, attention, active, prioritizeActive, values],
  );
  const layout = useMemo(() => layoutTree({ tree: graphTree, shown, radius }), [graphTree, shown, radius]);
  useEffect(refit, [prioritizeActive, hideUnscored, scoreKey]);

  useEffect(() => {
    const params = new URLSearchParams({ ...(view !== QUALITY && { project: view }), ...(liveFocus && { focus: liveFocus }) });
    globalThis.history?.replaceState(null, "", params.size ? `?${params}` : location.pathname);
  }, [liveFocus, view]);

  const statKeys = useMemo(() => statMetrics(metricDefs, state.weights), [metricDefs, state.weights]);
  const look = useMemo(
    () => tileLooks({ scores, scoreKey, statKeys }),
    [scores, scoreKey, statKeys],
  );
  const previousScores = useRef(scores);
  const deltas = useMemo(() => {
    const changed = scoreDeltas(previousScores.current, scores, scoreKey);
    previousScores.current = scores;
    return changed;
  }, [scores]);
  const compositeColor = useMemo(() => {
    const color = ramp(Object.values(scores).map((s) => s.quality));
    return (score: number) => color(score);
  }, [scores]);

  const select = (id: NodeId | null, project?: string) => {
    if (project !== undefined && project !== view) onSwitch(project);
    setSelected(id);
    if (id === null || !Object.hasOwn(tree.nodes, id)) return;
    setFocus(id);
    setOverrides(new Map());
    setFitRequest((n) => n + 1);
  };
  const switchTo = (next: string) => {
    if (next === ALL_PROJECTS) setSelected(null);
    onSwitch(next);
  };
  const onToggle = (id: NodeId) => {
    const hiding = (layout.byId.get(id)?.hiddenChildren ?? 0) > 0 || layout.byId.has(stubId(id));
    setOverrides((o) => toggleOverride(o, id, hiding, isAncestor(tree, id, liveFocus)));
  };
  const onStub = (parent: NodeId) => {
    if (parent === liveFocus || isAncestor(tree, liveFocus, parent)) setOverrides((o) => toggleOverride(o, parent, true, false));
    else select(parent);
  };
  const scoreChoices = metricDefs.filter((d) => d.direction !== "neutral");
  const weightChoices = metricDefs.filter((d) => d.aggregate === "sum" || d.aggregate === "max");

  return (
    <div class="app">
      <header class="toolbar">
        <strong>techtree</strong>
        <span class="muted">{state.repo.name}</span>
        <ProjectSwitcher projects={projects} view={view} onSwitch={switchTo} onChanged={onProjectsChanged} onError={setError} />
        <label>
          Score
          <select value={scoreKey} onChange={(e) => setScoreKey((e.currentTarget as HTMLSelectElement).value)}>
            <option value={COMPOSITE}>Composite</option>
            {scoreChoices.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Size
          <select value={weightKey} onChange={(e) => setWeightKey((e.currentTarget as HTMLSelectElement).value)}>
            {weightChoices.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select value={sortKey} onChange={(e) => setSortKey((e.currentTarget as HTMLSelectElement).value as SortKey)}>
            <option value="name">Name</option>
            <option value="score">Score</option>
            <option value="weight">Size</option>
          </select>
        </label>
        <label>
          Prioritize
          <select value={prioritizeActive ? "active" : "inactive"} onChange={(e) => setPrioritizeActive(e.currentTarget.value === "active")}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={hideUnscored} onChange={(e) => setHideUnscored(e.currentTarget.checked)} />
          Hide unscored
        </label>
        <button onClick={() => setFitRequest((n) => n + 1)}>Fit</button>
        <span class="muted small">{layout.nodes.length} shown</span>
        <span class="spacer" />
        {notice && <span class="muted small">{notice}</span>}
        <button onClick={() => post(`/api/score?project=${encodeURIComponent(state.project.id)}`).catch((e: Error) => setError(e.message))}>Rescore</button>
      </header>
      {error && (
        <div class="error-bar" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <main style={{ "--panel-width": `${panelWidth}px`, "--outbox-width": `${outboxWidth}px` }}>
        <GroupContext.Provider value={groupValue(grouped, setGrouped, state.project.id)}>
        <div class="panel-column">
        {selected === null || selected === "" ? (
          <Overview
            state={state}
            view={view}
            projects={projects}
            version={version}
            eventTick={eventTick}
            onSelect={select}
            onStart={(s) => setStarting({ suggestion: s, findings: [], project: s.project ?? state.project.id })}
            onError={setError}
          />
        ) : (
          <NodePanel
            id={selected}
            state={state}
            version={version}
            onStart={(suggestion, findings) => setStarting({ suggestion, findings, project: state.project.id })}
            onSelect={select}
            onError={setError}
            onClose={() => setSelected(null)}
          />
        )}
        {grouped.length > 0 && (
          <div class="group-bar">
            {grouped.length} selected
            <button
              class="primary"
              disabled={grouped.length < 2}
              onClick={() => {
                setStarting({ suggestion: combineSuggestions(grouped), findings: [], project: grouped[0].project ?? state.project.id });
                setGrouped([]);
              }}
            >
              Start together
            </button>
            <button class="link" onClick={() => setGrouped([])}>
              Clear
            </button>
          </div>
        )}
        </div>
        </GroupContext.Provider>
        <PanelResizer edge="right" label="Resize inbox" width={panelWidth} onResize={setPanelWidth} onResizeEnd={refit} />
        <TreeView
          tree={graphTree}
          layout={layout}
          look={look}
          deltas={deltas}
          edgeWidth={edgeWidth}
          compositeColor={compositeColor}
          tasks={state.tasks}
          prs={state.prs}
          suggestionCounts={state.suggestionCounts}
          attention={attention}
          selected={selected}
          fitRequest={fitRequest}
          onSelect={select}
          onToggle={onToggle}
          onStub={onStub}
        />
        <PanelResizer edge="left" label="Resize outbox" width={outboxWidth} onResize={setOutboxWidth} onResizeEnd={refit} />
        <Outbox projects={projects} version={version} onSelect={select} onError={setError} />
      </main>
      {starting && <StartDialog {...starting} onClose={() => setStarting(null)} onError={setError} />}
    </div>
  );
}

/** Grouping state for suggestion checkboxes: one project at a time (DESIGN "Grouping suggestions"). */
function groupValue(grouped: Suggestion[], setGrouped: (fn: (g: Suggestion[]) => Suggestion[]) => void, current: string) {
  const projectOf = (s: Suggestion) => s.project ?? current;
  return {
    selected: grouped,
    canSelect: (s: Suggestion) => !grouped.length || projectOf(grouped[0]) === projectOf(s),
    toggle: (s: Suggestion) => setGrouped((g) => toggleSuggestion(g, s, current)),
  };
}

/** The project named by the page's `?project=` parameter ("all" for every project), or all projects. */
function initialView(): string {
  return new URLSearchParams(globalThis.location?.search).get("project") || ALL_PROJECTS;
}

/** The node named by the page's `?focus=` parameter, or the root. */
function initialFocus(state: ApiState): NodeId {
  const id = new URLSearchParams(globalThis.location?.search).get("focus");
  return id !== null && Object.hasOwn(state.tree.nodes, id) ? id : "";
}

function isAncestor(tree: ApiState["tree"], id: NodeId, of: NodeId): boolean {
  for (let p = tree.nodes[of]?.parent ?? null; p !== null; p = tree.nodes[p].parent) if (p === id) return true;
  return false;
}

function upsert<T>(items: T[], item: T, key: (item: T) => string | number): T[] {
  const index = items.findIndex((x) => key(x) === key(item));
  return index < 0 ? [...items, item] : items.map((x, i) => (i === index ? item : x));
}

render(<App />, document.getElementById("app")!);
