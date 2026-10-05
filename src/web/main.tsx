import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ApiState, Finding, NodeId, Suggestion } from "../types.ts";
import { get, onReconnect, onServerEvent, post } from "./api.ts";
import { initialExpanded, layoutTree, siblingOrder, toggled, type SortKey } from "./layout.ts";
import { ramp, sqrtScale } from "./visual.ts";
import { TreeView } from "./TreeView.tsx";
import { NodePanel, StartDialog } from "./Panel.tsx";
import { Overview } from "./Overview.tsx";

const COMPOSITE = "quality";

function App() {
  const [state, setState] = useState<ApiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = () => get<ApiState>("/api/state").then(setState, (e: Error) => setError(e.message));

  const resync = () => void load().then(() => setVersion((v) => v + 1));

  useEffect(() => {
    void load();
    const stopReconnect = onReconnect(resync);
    const stopEvents = onServerEvent((event) => {
      if (event.type === "task") {
        setState((s) => s && { ...s, tasks: upsert(s.tasks, event.task, (t) => t.id) });
      } else if (event.type === "pr") {
        setState((s) => s && { ...s, prs: upsert(s.prs, event.pr, (p) => p.number) });
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
  return <Main state={state} version={version} error={error} notice={notice} setError={setError} />;
}

interface MainProps {
  state: ApiState;
  version: number;
  error: string | null;
  notice: string | null;
  setError(message: string | null): void;
}

function Main({ state, version, error, notice, setError }: MainProps) {
  const [scoreKey, setScoreKey] = useState(COMPOSITE);
  const [weightKey, setWeightKey] = useState("loc");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [starting, setStarting] = useState<{ suggestion: Suggestion; findings: Finding[] } | null>(null);
  const { tree, scores, metricDefs } = state;

  const scoreOf = useCallback(
    (id: NodeId) => (scoreKey === COMPOSITE ? scores[id]?.quality : scores[id]?.metrics[scoreKey]?.pct) ?? null,
    [scores, scoreKey],
  );
  const weightOf = useCallback((id: NodeId) => scores[id]?.metrics[weightKey]?.raw ?? 0, [scores, weightKey]);
  const maxWeight = useMemo(() => weightOf(""), [weightOf]);
  const radius = useMemo(() => {
    const scale = sqrtScale(maxWeight, 3, 22);
    return (id: NodeId) => scale(weightOf(id));
  }, [weightOf, maxWeight]);
  const edgeWidth = useMemo(() => {
    const scale = sqrtScale(maxWeight, 1, 14);
    return (id: NodeId) => scale(weightOf(id));
  }, [weightOf, maxWeight]);

  const sortBasis = sortKey === "score" ? scoreOf : sortKey === "weight" ? weightOf : null;
  const order = useMemo(() => siblingOrder(sortKey, scoreOf, weightOf), [sortKey, sortBasis]);
  const [expanded, setExpanded] = useState(() => initialExpanded(tree, order));
  const layout = useMemo(() => layoutTree({ tree, expanded, radius, order }), [tree, expanded, radius, order]);

  const fill = useMemo(() => {
    const color = ramp(Object.keys(tree.nodes).map(scoreOf));
    return (id: NodeId) => color(scoreOf(id));
  }, [tree, scoreOf]);
  const compositeColor = useMemo(() => {
    const color = ramp(Object.values(scores).map((s) => s.quality));
    return (score: number) => color(score);
  }, [scores]);

  const select = (id: NodeId | null) => {
    setSelected(id);
    if (id === null) return;
    const ancestors = new Set(expanded);
    for (let p = tree.nodes[id]?.parent; p != null; p = tree.nodes[p].parent) ancestors.add(p);
    if (ancestors.size !== expanded.size) setExpanded(ancestors);
  };
  const onToggle = useCallback((id: NodeId) => setExpanded((e) => toggled(e, id)), []);
  const scoreChoices = metricDefs.filter((d) => d.direction !== "neutral");
  const weightChoices = metricDefs.filter((d) => d.aggregate === "sum" || d.aggregate === "max");

  return (
    <div class="app">
      <header class="toolbar">
        <strong>techtree</strong>
        <span class="muted">{state.repo.name}</span>
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
        <button onClick={() => post("/api/score").catch((e: Error) => setError(e.message))}>Rescore</button>
      </header>
      {error && (
        <div class="error-bar" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <main>
        <TreeView
          tree={tree}
          layout={layout}
          fill={fill}
          edgeWidth={edgeWidth}
          compositeColor={compositeColor}
          tasks={state.tasks}
          prs={state.prs}
          selected={selected}
          fitRequest={fitRequest}
          onSelect={select}
          onToggle={onToggle}
        />
        {selected === null ? (
          <Overview state={state} version={version} onSelect={select} onStart={(s) => setStarting({ suggestion: s, findings: [] })} onError={setError} />
        ) : (
          <NodePanel
            id={selected}
            state={state}
            version={version}
            onStart={(suggestion, findings) => setStarting({ suggestion, findings })}
            onError={setError}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
      {starting && <StartDialog {...starting} onClose={() => setStarting(null)} onError={setError} />}
    </div>
  );
}

function upsert<T>(items: T[], item: T, key: (item: T) => string | number): T[] {
  const index = items.findIndex((x) => key(x) === key(item));
  return index < 0 ? [...items, item] : items.map((x, i) => (i === index ? item : x));
}

render(<App />, document.getElementById("app")!);
