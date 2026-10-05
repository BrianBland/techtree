import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiModels, ApiNode, ApiState, Cta, Finding, NodeId, PrState, StartTaskRequest, Suggestion, Task } from "../types.ts";
import { get, onServerEvent, post } from "./api.ts";
import { sparkline, taskCompletion } from "./visual.ts";

const LOG_TAIL = 200;

export interface NodePanelProps {
  id: NodeId;
  state: ApiState;
  /** Bumped when scores change or the event stream reconnects, so details are refetched. */
  version: number;
  onStart(suggestion: Suggestion, findings: Finding[]): void;
  onSelect(id: NodeId): void;
  onError(message: string): void;
  onClose(): void;
}

export function NodePanel({ id, state, version, onStart, onSelect, onError, onClose }: NodePanelProps) {
  const [fetched, setFetched] = useState<{ id: NodeId; detail: ApiNode } | null>(null);
  const detail = fetched?.id === id ? fetched.detail : null;
  const node = state.tree.nodes[id];
  const tasks = state.tasks.filter((t) => t.node === id);
  const prs = state.prs.filter((p) => p.node === id);

  useEffect(() => {
    let live = true;
    get<ApiNode>(`/api/node?id=${encodeURIComponent(id)}`).then((d) => live && setFetched({ id, detail: d }), (e: Error) => onError(e.message));
    return () => {
      live = false;
    };
  }, [id, version, attentionKey(state)]);

  const scan = () => post("/api/scan", { node: id }).catch((e: Error) => onError(e.message));

  return (
    <aside class="panel">
      <header>
        <div>
          <h2>{node.name}</h2>
          <div class="muted">
            {id || "(repo root)"} · {node.kind}
          </div>
        </div>
        <div class="score-big">{fmt(state.scores[id]?.quality)}</div>
        <button class="link" onClick={onClose} title="Back to overview">
          close
        </button>
      </header>
      <div class="actions">
        <button onClick={scan}>Scan subtree</button>
      </div>
      {detail ? <Detail id={id} detail={detail} state={state} onStart={onStart} onSelect={onSelect} onError={onError} /> : <p class="muted">Loading…</p>}
      <Section title="Pull requests" items={prs}>
        {(pr) => <PrRow key={pr.number} pr={pr} onError={onError} />}
      </Section>
      <Section title="Tasks" items={tasks}>
        {(task) => <TaskCard key={task.id} task={task} version={version} onError={onError} />}
      </Section>
    </aside>
  );
}

interface DetailProps extends Pick<NodePanelProps, "id" | "state" | "onStart" | "onSelect" | "onError"> {
  detail: ApiNode;
}

function Detail({ id, detail, state, onStart, onSelect, onError }: DetailProps) {
  const findingsById = new Map(detail.findings.map((f) => [f.id, f]));
  const start = (s: Suggestion) => onStart(s, s.findingIds.map((fid) => findingsById.get(fid)!).filter(Boolean));
  return (
    <>
      <section class="ctas">
        <h3>This node</h3>
        {detail.ownCtas.length ? (
          <ul class="list">{detail.ownCtas.map((cta) => <OwnCta key={ctaKey(cta)} cta={cta} state={state} onStart={start} onError={onError} />)}</ul>
        ) : (
          <p class="muted small">Nothing to do here.</p>
        )}
      </section>
      <Section title="From children" items={detail.childCtas}>
        {(cta) => <ChildCta key={ctaKey(cta)} cta={cta} from={id} onSelect={onSelect} />}
      </Section>
      <table class="metrics">
        <tbody>
          <tr>
            <th>Composite</th>
            <td />
            <td class="num">{fmt(detail.score.quality)}</td>
            <td>
              <Sparkline values={detail.history.map((h) => h.quality)} />
            </td>
          </tr>
          {state.metricDefs.map((def) => {
            const m = detail.score.metrics[def.key];
            if (!m) return null;
            return (
              <tr key={def.key}>
                <th>{def.label}</th>
                <td class="num muted">
                  {fmt(m.value)}
                  {def.unit ? ` ${def.unit}` : ""}
                </td>
                <td class="num">{m.pct === null ? "" : `p${Math.round(m.pct)}`}</td>
                <td>{m.pct !== null && <Sparkline values={detail.history.map((h) => h.metrics[def.key] ?? null)} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Section title="Findings" items={[...detail.findings].sort((a, b) => b.impact.node - a.impact.node)}>
        {(f) => (
          <li key={f.id}>
            <span class={`sev ${f.severity}`}>{f.severity}</span> {f.title}
            <div class="muted small">
              {f.source} · {f.file}
              {f.line ? `:${f.line}` : ""} · {f.effort} · +{fmt(f.impact.node)} here, +{fmt(f.impact.root)} root
            </div>
          </li>
        )}
      </Section>
    </>
  );
}

function ctaKey(cta: Cta): string {
  return cta.task?.id ?? (cta.pr ? `pr${cta.pr.number}` : `${cta.node}:${cta.suggestion!.title}:${cta.suggestion!.findingIds.join()}`);
}

/** A call to action at the selected node, with its action; tasks and PRs are read live from `state`. */
function OwnCta({ cta, state, onStart, onError }: { cta: Cta; state: ApiState; onStart(s: Suggestion): void; onError(message: string): void }) {
  if (cta.suggestion) {
    const s = cta.suggestion;
    return (
      <li>
        <SuggestionRow suggestion={s} onStart={() => onStart(s)} />
      </li>
    );
  }
  if (cta.pr) return <PrRow pr={state.prs.find((p) => p.number === cta.pr!.number) ?? cta.pr} reason={cta.reason} onError={onError} />;
  const task = state.tasks.find((t) => t.id === cta.task!.id) ?? cta.task!;
  return (
    <li class="cta">
      <Reason cta={cta} /> <strong>{task.title}</strong>
      {task.state === "needs_input" && <AnswerForm task={task} onError={onError} />}
      {task.state === "review" && <ReviewDiff task={task} onError={onError} />}
    </li>
  );
}

/** A call to action from a descendant, labelled with its path relative to `from`; clicking selects it. */
function ChildCta({ cta, from, onSelect }: { cta: Cta; from: NodeId; onSelect(id: NodeId): void }) {
  return (
    <li class="row clickable cta-child" onClick={() => onSelect(cta.node)}>
      <div>
        <Reason cta={cta} /> {cta.task?.title ?? cta.pr?.title ?? cta.suggestion?.title}
        <div class="path small">{from === "" ? cta.node : cta.node.slice(from.length + 1)}</div>
      </div>
    </li>
  );
}

function Reason({ cta }: { cta: Pick<Cta, "kind" | "reason"> }) {
  return <span class={`reason ${cta.kind}`}>{cta.reason}</span>;
}

/** POST a task action; resolves to whether it succeeded, reporting failures through `onError`. */
function taskAction(task: Task, path: string, onError: (message: string) => void, body?: unknown): Promise<boolean> {
  return post(`/api/tasks/${task.id}/${path}`, body).then(
    () => true,
    (e: Error) => {
      onError(e.message);
      return false;
    },
  );
}

function AnswerForm({ task, onError }: { task: Task; onError(message: string): void }) {
  const [answer, setAnswer] = useState("");
  return (
    <form
      class="answer"
      onSubmit={(e) => {
        e.preventDefault();
        void taskAction(task, "answer", onError, { text: answer }).then((ok) => ok && setAnswer(""));
      }}
    >
      <p>{task.question}</p>
      <textarea value={answer} onInput={(e) => setAnswer((e.currentTarget as HTMLTextAreaElement).value)} rows={3} />
      <button type="submit" disabled={!answer.trim()}>
        Answer
      </button>
    </form>
  );
}

function ReviewDiff({ task, onError }: { task: Task; onError(message: string): void }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    get<string>(`/api/tasks/${task.id}/diff`).then(setDiff, (e: Error) => onError(e.message));
  }, [task.id]);
  return (
    <div>
      <pre class="diff">
        {(diff ?? "").split("\n").map((line, i) => (
          <div key={i} class={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}>
            {line || " "}
          </div>
        ))}
      </pre>
      <button class="primary" onClick={() => taskAction(task, "open-pr", onError)}>
        Open PR
      </button>
    </div>
  );
}

/**
 * Changes whenever a task changes state or a PR's attention flags change anywhere in the repo,
 * so views showing calls to action (own or descendants') know to refetch.
 */
export function attentionKey(state: ApiState): string {
  const tasks = state.tasks.map((t) => t.id + t.state).join();
  const prs = state.prs.map((p) => [p.number, p.ci, p.babysit, p.stale, p.stuck].join(":")).join();
  return `${tasks}|${prs}`;
}

export function SuggestionRow({ suggestion: s, onStart }: { suggestion: Suggestion; onStart(): void }) {
  return (
    <div class="row">
      <div>
        {s.title}
        <div class="muted small">
          +{fmt(s.impact.node)} here · {s.effort} · priority {fmt(s.priority)}
          {s.conflict > 0 ? ` · conflict ${Math.round(s.conflict * 100)}%` : ""}
        </div>
      </div>
      <button onClick={onStart}>Start</button>
    </div>
  );
}

export function PrRow({ pr, reason, onError }: { pr: PrState; reason?: string; onError(message: string): void }) {
  const toggle = (e: Event) =>
    post(`/api/prs/${pr.number}/babysit`, { on: (e.currentTarget as HTMLInputElement).checked }).catch((err: Error) => onError(err.message));
  return (
    <li class="row">
      <div>
        {reason && (
          <>
            <Reason cta={{ kind: "pr", reason }} />{" "}
          </>
        )}
        <a href={pr.url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>{" "}
        {pr.title}
        <div class="muted small">
          <span class={`ci ${pr.ci}`}>CI {pr.ci}</span>
          {pr.review ? ` · ${pr.review.toLowerCase().replace(/_/g, " ")}` : ""}
          {pr.stuck ? " · stuck" : ""}
          {pr.stale ? " · stale" : ""} · {pr.author}
        </div>
      </div>
      <label class="small">
        <input type="checkbox" checked={pr.babysit} onChange={toggle} /> babysit
      </label>
    </li>
  );
}

export function TaskCard({ task, version, onError }: { task: Task; version: number; onError(message: string): void }) {
  const [log, setLog] = useState<string[]>([]);
  const logEl = useRef<HTMLPreElement>(null);
  const showLog = ["running", "needs_input", "review", "failed"].includes(task.state);

  useEffect(() => {
    if (!showLog) return;
    let live = true;
    get<string>(`/api/tasks/${task.id}/log?tail=${LOG_TAIL}`).then((text) => live && setLog(text ? text.split("\n") : []), () => {});
    const unsubscribe = onServerEvent((e) => {
      if (e.type === "log" && e.taskId === task.id) setLog((lines) => [...lines.slice(1 - LOG_TAIL), e.line]);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id, showLog, version]);

  useEffect(() => {
    logEl.current?.scrollTo(0, logEl.current.scrollHeight);
  }, [log]);


  return (
    <li class="task">
      <div class="row">
        <div>
          <strong>{task.title}</strong>
          <div class="muted small">
            <span class={`state ${task.state}`}>{task.state.replace("_", " ")}</span> · {task.phase} ·{" "}
            {Math.round(taskCompletion(task) * 100)}% · {fmt(task.plannedFrom)} → {fmt(task.plannedTo)}
            {task.manualReview ? " · manual review" : ""}
            {task.model ? ` · ${task.model}` : ""}
            {task.pr ? ` · PR #${task.pr}` : ""}
          </div>
        </div>
        <span>
          {["queued", "running", "needs_input", "review"].includes(task.state) && (
            <button class="link" onClick={() => taskAction(task, "cancel", onError)}>
              cancel
            </button>
          )}
          {task.state !== "pr_open" && (
            <button
              class="link"
              title="Delete the worktree, local branch and task without opening a PR"
              onClick={() => confirm(`Discard "${task.title}"? Its worktree and local branch are deleted.`) && taskAction(task, "discard", onError)}
            >
              discard
            </button>
          )}
        </span>
      </div>
      {task.checklist.length > 0 && (
        <ul class="checklist">
          {task.checklist.map((item, i) => (
            <li key={i} class={item.done ? "done" : undefined}>
              {item.done ? "■" : "□"} {item.text}
            </li>
          ))}
        </ul>
      )}
      {task.error && <p class="error small">{task.error}</p>}
      {showLog && log.length > 0 && (
        <pre class="log" ref={logEl}>
          {log.join("\n")}
        </pre>
      )}
    </li>
  );
}

export function StartDialog({
  suggestion,
  findings,
  onClose,
  onError,
}: {
  suggestion: Suggestion;
  findings: Finding[];
  onClose(): void;
  onError(message: string): void;
}) {
  const [title, setTitle] = useState(suggestion.title);
  const [prompt, setPrompt] = useState(defaultPrompt(suggestion, findings));
  const [manualReview, setManualReview] = useState(suggestion.manualReview);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [modelsLoad, setModelsLoad] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    get<ApiModels>("/api/models").then(
      (m) => {
        setModels(m.models);
        setModel(m.default ?? "");
        setModelsLoad("ready");
      },
      () => setModelsLoad("failed"),
    );
  }, []);
  const submit = (e: Event) => {
    e.preventDefault();
    if (modelsLoad === "loading") return;
    const request: StartTaskRequest = { node: suggestion.node, findingIds: suggestion.findingIds, title, prompt, manualReview, ...(model && { model }) };
    post<Task>("/api/tasks", request).then(
      onClose,
      (err: Error) => onError(err.message),
    );
  };
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="dialog" onSubmit={submit}>
        <h3>Start task</h3>
        <label>
          Title
          <input value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label>
          Prompt
          <textarea rows={10} value={prompt} onInput={(e) => setPrompt((e.currentTarget as HTMLTextAreaElement).value)} />
        </label>
        <label>
          Model
          <select value={model} disabled={modelsLoad === "loading"} onChange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">pi default</option>
            {model && !models.includes(model) && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {modelsLoad === "loading" && <span class="small">Loading models…</span>}
          {modelsLoad === "failed" && <span class="small error">Could not load models; the task will use pi's default.</span>}
        </label>
        <label class="inline">
          <input type="checkbox" checked={manualReview} onChange={(e) => setManualReview((e.currentTarget as HTMLInputElement).checked)} />
          Manual review before PR
        </label>
        <div class="buttons">
          <button type="button" class="link" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={modelsLoad === "loading"}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}

function defaultPrompt(s: Suggestion, findings: Finding[]): string {
  const lines = findings.length
    ? findings.map((f) => `- ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}: ${f.detail}`)
    : s.findingIds.map((id) => `- finding ${id}`);
  return `${s.title}\n\nDirectory: ${s.node || "(repo root)"}\n\nFindings to fix:\n${lines.join("\n")}`;
}

export function Section<T>({ title, items, children }: { title: string; items: T[]; children: (item: T) => ComponentChildren }) {
  if (!items.length) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul class="list">{items.map(children)}</ul>
    </section>
  );
}

function Sparkline({ values }: { values: (number | null)[] }) {
  return (
    <svg class="spark" width="60" height="16">
      <polyline points={sparkline(values, 60, 16)} />
    </svg>
  );
}

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
