import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ALL_PROJECTS, QUALITY } from "../core/projects.ts";
import type { ApiState, Finding, NodeId, Project, Suggestion } from "../types.ts";
import { get, onReconnect, onServerEvent, post } from "./api.ts";
import { focusView, layoutTree, siblingOrder, stubId, toggleOverride, type Overrides, type SortKey } from "./layout.ts";
import { attentionNodes, COMPOSITE, ramp, scoreDeltas, scoreValue, sqrtScale, statMetrics, subtreeValues, tileLooks, tileSize } from "./visual.ts";
import { TreeView } from "./TreeView.tsx";
import { NodePanel, StartDialog } from "./Panel.tsx";
import { Overview } from "./Overview.tsx";
import { PanelResizer, usePanelWidth } from "./PanelResizer.tsx";
import { ProjectSwitcher } from "./Projects.tsx";

function App() {
  const [view, setView] = useState(initialView);
  const [treeProject, setTreeProject] = useState(view === ALL_PROJECTS ? QUALITY : view);
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ApiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [eventTick, setEventTick] = useState(0);
  const shownProject = useRef(treeProject);
  shownProject.current = treeProject;

  const load = () => {
    const project = shownProject.current;
    return get<ApiState>(`/api/state?project=${encodeURIComponent(project)}`).then(
      (s) => project === shownProject.current && setState(s),
      (e: Error) => setError(e.message),
    );
  };
  const loadProjects = () => get<Project[]>("/api/projects").then(setProjects, (e: Error) => setError(e.message));

  const resync = () => void load().then(() => setVersion((v) => v + 1));

  const switchView = (next: string) => {
    setView(next);
    if (next !== ALL_PROJECTS) setTreeProject(next);
  };

  useEffect(() => void load(), [treeProject]);

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
      } else if (event.type === "pr") {
        setEventTick((n) => n + 1);
        const ours = (event.pr.project ?? QUALITY) === shownProject.current;
        setState((s) => s && { ...s, prs: ours ? upsert(s.prs, event.pr, (p) => p.number) : s.prs.filter((p) => p.number !== event.pr.number) });
      } else if (event.type === "task_removed") {
        setEventTick((n) => n + 1);
        setState((s) => s && { ...s, tasks: s.tasks.filter((t) => t.id !== event.taskId) });
      } else if (event.type === "pr_removed") {
        setEventTick((n) => n + 1);
        setState((s) => s && { ...s, prs: s.prs.filter((p) => p.number !== event.number) });
      } else if (event.type === "scores") {
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

  if (!state) return <div class="loading">{error ?? "Loading…"}</div>;
  const onProjectsChanged = (next: string) =>
    void loadProjects().then(() => {
      switchView(next);
      if (next === shownProject.current) void load();
    });
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
  const [focus, setFocus] = useState<NodeId>(() => initialFocus(state));
  const [selected, setSelected] = useState<NodeId | null>(focus || null);
  const [overrides, setOverrides] = useState<Overrides>(new Map());
  const [fitRequest, setFitRequest] = useState(0);
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [starting, setStarting] = useState<{ suggestion: Suggestion; findings: Finding[]; project: string } | null>(null);
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
  const values = useMemo(() => subtreeValues(state), [tree, scores, state.tasks, state.prs, state.findingCounts]);
  const liveFocus = Object.hasOwn(tree.nodes, focus) ? focus : "";
  const shown = useMemo(
    () => focusView({ tree, focus: liveFocus, order, overrides, attention, values }),
    [tree, liveFocus, order, overrides, attention, values],
  );
  const layout = useMemo(() => layoutTree({ tree, shown, radius }), [tree, shown, radius]);

  useEffect(() => {
    const params = new URLSearchParams({ ...(view !== QUALITY && { project: view }), ...(liveFocus && { focus: liveFocus }) });
    globalThis.history?.replaceState(null, "", params.size ? `?${params}` : location.pathname);
  }, [liveFocus, view]);

  const statKeys = useMemo(() => statMetrics(metricDefs, state.weights), [metricDefs, state.weights]);
  const look = useMemo(
    () => tileLooks({ scores, scoreKey, statKeys, findingCounts: state.findingCounts }),
    [scores, scoreKey, statKeys, state.findingCounts],
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
      <main style={{ "--panel-width": `${panelWidth}px` }}>
        <TreeView
          tree={tree}
          layout={layout}
          look={look}
          deltas={deltas}
          edgeWidth={edgeWidth}
          compositeColor={compositeColor}
          tasks={state.tasks}
          prs={state.prs}
          attention={attention}
          selected={selected}
          fitRequest={fitRequest}
          onSelect={select}
          onToggle={onToggle}
          onStub={onStub}
        />
        <PanelResizer width={panelWidth} onResize={setPanelWidth} onResizeEnd={() => setFitRequest((n) => n + 1)} />
        {selected === null ? (
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
      </main>
      {starting && <StartDialog {...starting} onClose={() => setStarting(null)} onError={setError} />}
    </div>
  );
}

/** The project named by the page's `?project=` parameter ("all" for every project), or Quality. */
function initialView(): string {
  return new URLSearchParams(globalThis.location?.search).get("project") || QUALITY;
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
