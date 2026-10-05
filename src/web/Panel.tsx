import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiModels, ApiNode, ApiSource, ApiState, ChatEntry, Cta, Finding, NodeId, PrState, ScorerSpec, StartTaskRequest, Suggestion, Task, TerminalMode } from "../types.ts";
import { isScannable } from "../core/projects.ts";
import { get, onServerEvent, post } from "./api.ts";
import { linkify } from "./linkify.ts";
import { hasLiveWorker, messageBlocked } from "./task-actions.ts";
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
  const [fetched, setFetched] = useState<{ id: NodeId; project: string; detail: ApiNode } | null>(null);
  const project = state.project.id;
  const detail = fetched?.id === id && fetched.project === project ? fetched.detail : null;
  const node = state.tree.nodes[id];
  const tasks = state.tasks.filter((t) => t.node === id);
  const prs = state.prs.filter((p) => p.node === id);
  const projectQuery = `project=${encodeURIComponent(project)}`;

  useEffect(() => {
    let live = true;
    get<ApiNode>(`/api/node?id=${encodeURIComponent(id)}&${projectQuery}`).then((d) => live && setFetched({ id, project, detail: d }), (e: Error) => onError(e.message));
    return () => {
      live = false;
    };
  }, [id, projectQuery, version, attentionKey(state)]);

  const scan = () => post(`/api/scan?${projectQuery}`, { node: id }).catch((e: Error) => onError(e.message));

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
        <button onClick={() => onStart(freeTask(id), [])}>New task here</button>
        {isScannable(state.project) && <button onClick={scan}>Scan subtree</button>}
      </div>
      {detail ? <Detail id={id} detail={detail} state={state} version={version} onStart={onStart} onSelect={onSelect} onError={onError} /> : <p class="muted">Loading…</p>}
      <Section title="Pull requests" items={prs}>
        {(pr) => <PrRow key={pr.number} pr={pr} onError={onError} />}
      </Section>
      <Section title="Tasks" items={tasks}>
        {(task) => <TaskCard key={task.id} task={task} prs={state.prs} scorer={state.project.scorer} version={version} onError={onError} />}
      </Section>
    </aside>
  );
}

interface DetailProps extends Pick<NodePanelProps, "id" | "state" | "version" | "onStart" | "onSelect" | "onError"> {
  detail: ApiNode;
}

function Detail({ id, detail, state, version, onStart, onSelect, onError }: DetailProps) {
  const findingsById = new Map(detail.findings.map((f) => [f.id, f]));
  const start = (s: Suggestion) => onStart(s, s.findingIds.map((fid) => findingsById.get(fid)!).filter(Boolean));
  return (
    <>
      <section class="ctas">
        <h3>This node</h3>
        {detail.ownCtas.length ? (
          <ul class="list">{detail.ownCtas.map((cta) => <OwnCta key={ctaKey(cta)} cta={cta} state={state} version={version} onStart={start} onError={onError} />)}</ul>
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
      {detail.dismissed.length > 0 && (
        <details class="dismissed">
          <summary class="muted small">{detail.dismissed.length} dismissed</summary>
          <ul class="list">
            {detail.dismissed.map((f) => (
              <li key={f.id} class="row">
                <div>
                  {linkify(f.title)}
                  <div class="muted small">
                    {f.source} · {f.file}
                    {f.reason ? ` · ${f.reason}` : ""}
                  </div>
                </div>
                <button onClick={() => post("/api/findings/undismiss", { findingIds: [f.id] }).catch((e: Error) => onError(e.message))}>Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Section title="Findings" items={[...detail.findings].sort((a, b) => b.impact.node - a.impact.node)}>
        {(f) => (
          <li key={f.id}>
            <span class={`sev ${f.severity}`}>{f.severity}</span> {linkify(f.title)}
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
function OwnCta({ cta, state, version, onStart, onError }: { cta: Cta; state: ApiState; version: number; onStart(s: Suggestion): void; onError(message: string): void }) {
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
      <TaskActions task={task} prs={state.prs} scorer={state.project.scorer} version={version} onError={onError} />
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
  return <span class={`reason ${cta.kind}`}>{linkify(cta.reason)}</span>;
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

/** Confirm the agent's proposed dismissal, or dismiss all the task's findings with a reason asked for. */
function dismissFindings(task: Task, onError: (message: string) => void): void {
  const proposal = task.proposedDismiss;
  const reason = proposal ? proposal.reason : prompt("Why dismiss these findings? (e.g. false positive, won't fix)", "false positive");
  if (reason === null) return;
  const findingIds = proposal?.findingIds ?? task.findingIds;
  post("/api/findings/dismiss", { findingIds, reason, project: task.project }).catch((e: Error) => onError(e.message));
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
      <p>{linkify(task.question ?? "")}</p>
      <textarea value={answer} onInput={(e) => setAnswer((e.currentTarget as HTMLTextAreaElement).value)} rows={3} />
      <button type="submit" disabled={!answer.trim()}>
        Answer
      </button>
    </form>
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
        {linkify(s.title)}
        <div class="muted small">
          +{fmt(s.impact.node)} here · {s.effort} · priority {fmt(s.priority)}
          {s.conflict > 0 ? ` · conflict ${Math.round(s.conflict * 100)}%` : ""}
        </div>
      </div>
      <button onClick={onStart}>Start</button>
    </div>
  );
}

export function PrRow({ pr, reason, tag, onError }: { pr: PrState; reason?: string; tag?: ComponentChildren; onError(message: string): void }) {
  const toggle = (e: Event) =>
    post(`/api/prs/${pr.number}/babysit`, { on: (e.currentTarget as HTMLInputElement).checked }).catch((err: Error) => onError(err.message));
  return (
    <li class="row">
      <div>
        {tag}
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

interface TaskActionsProps {
  task: Task;
  prs: PrState[];
  /** The project's current scorer, the base of a scorer task's proposal diff. */
  scorer: ScorerSpec;
  version: number;
  onError(message: string): void;
}

export function TaskCard({ task, prs, scorer, version, onError }: TaskActionsProps) {
  return (
    <li class="task">
      <div>
        <strong>{task.title}</strong>
        <div class="muted small">
          <span class={`state ${task.state}`}>{task.state.replace("_", " ")}</span> · {task.phase} ·{" "}
          {Math.round(taskCompletion(task) * 100)}% · {fmt(task.plannedFrom)} → {fmt(task.plannedTo)}
          {task.manualReview ? " · manual review" : ""}
          {task.model ? ` · ${task.model}` : ""}
        </div>
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
      {task.error && <p class="error small">{linkify(task.error)}</p>}
      {task.outcome === "no_change" && (
        <p class="summary">
          <strong>No change needed.</strong> {linkify(task.summary || "The agent finished without changes.")}
        </p>
      )}
      {task.proposedDismiss && (
        <p class="small">
          Agent proposes dismissing {task.proposedDismiss.findingIds.length} finding(s){task.proposedDismiss.reason ? `: ${task.proposedDismiss.reason}` : "."}
        </p>
      )}
      <TaskActions task={task} prs={prs} scorer={scorer} version={version} onError={onError} />
    </li>
  );
}

type Pane = "log" | "diff" | "chat";

/** The task's action bar (see docs/DESIGN.md "Task actions") and the panes it toggles. */
function TaskActions({ task, prs, scorer, version, onError }: TaskActionsProps) {
  const isChange = (task.kind ?? "change") === "change";
  const [open, setOpen] = useState<Set<Pane>>(new Set());
  useEffect(() => {
    if (task.state === "review" && isChange) setOpen((panes) => new Set(panes).add("diff"));
  }, [task.state]);
  const toggle = (pane: Pane) =>
    setOpen((panes) => {
      const next = new Set(panes);
      if (!next.delete(pane)) next.add(pane);
      return next;
    });
  const live = hasLiveWorker(task);
  const openTerminal = (mode: TerminalMode) => taskAction(task, "open-terminal", onError, { mode });
  const prUrl = prs.find((p) => p.number === task.pr)?.url;
  return (
    <div>
      {task.kind === "scorer" && task.state === "review" && <ProposalDiff current={scorer} proposal={task.proposal} />}
      <div class="action-bar">
        {task.state === "review" && isChange && (
          <button class="primary" onClick={() => taskAction(task, "open-pr", onError)}>
            Open PR
          </button>
        )}
        {task.state === "review" && task.kind === "scorer" && task.proposal && (
          <button class="primary" title="Save the proposal as the project's scorer and rescore" onClick={() => taskAction(task, "accept-scorer", onError)}>
            Accept scorer
          </button>
        )}
        {task.state === "review" && isChange && (
          <button title="Set aside for a combined PR with other staged tasks" onClick={() => taskAction(task, "stage", onError)}>
            Stage
          </button>
        )}
        {task.state === "staged" && <button onClick={() => taskAction(task, "unstage", onError)}>Unstage</button>}
        {task.findingIds.length > 0 && (
          <button title="Mark the task's findings as false positive / won't fix" onClick={() => dismissFindings(task, onError)}>
            Dismiss findings
          </button>
        )}
        {(live || task.state === "review") && <button onClick={() => taskAction(task, "cancel", onError)}>Cancel</button>}
        {task.state !== "pr_open" && (
          <button
            title="Delete the worktree, local branch and task without opening a PR"
            onClick={() => confirm(`Discard "${task.title}"? Its worktree and local branch are deleted.`) && taskAction(task, "discard", onError)}
          >
            Discard
          </button>
        )}
        <PaneToggle pane="log" open={open} toggle={toggle} />
        {task.worktree && (
          <>
            <PaneToggle pane="diff" open={open} toggle={toggle} />
            <PaneToggle pane="chat" open={open} toggle={toggle} />
            <button title="Open a terminal window with a shell in the task's worktree" onClick={() => openTerminal("shell")}>
              Open shell
            </button>
            <button
              title={live ? "The worker is using the session; cancel it first" : "Open a terminal window running pi on the task's session"}
              disabled={live}
              onClick={() => openTerminal("agent")}
            >
              Open agent
            </button>
          </>
        )}
        {task.pr !== undefined &&
          (prUrl ? (
            <a href={prUrl} target="_blank" rel="noreferrer">
              PR #{task.pr}
            </a>
          ) : (
            <span class="muted">PR #{task.pr}</span>
          ))}
      </div>
      {open.has("log") && <LogPane task={task} version={version} />}
      {open.has("diff") && <DiffPane task={task} onError={onError} />}
      {open.has("chat") && <ChatPane task={task} version={version} onError={onError} />}
    </div>
  );
}

const PANE_LABELS: Record<Pane, string> = { log: "Log", diff: "Diff", chat: "Chat" };

function PaneToggle({ pane, open, toggle }: { pane: Pane; open: Set<Pane>; toggle(pane: Pane): void }) {
  return (
    <button class={open.has(pane) ? "toggled" : undefined} aria-pressed={open.has(pane)} onClick={() => toggle(pane)}>
      {PANE_LABELS[pane]}
    </button>
  );
}

function LogPane({ task, version }: { task: Task; version: number }) {
  const [log, setLog] = useState<string[]>([]);
  const logEl = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    get<string>(`/api/tasks/${task.id}/log?tail=${LOG_TAIL}`).then((text) => live && setLog(text ? text.split("\n") : []), () => {});
    const unsubscribe = onServerEvent((e) => {
      if (e.type === "log" && e.taskId === task.id) setLog((lines) => [...lines.slice(1 - LOG_TAIL), e.line]);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id, version]);
  useEffect(() => {
    logEl.current?.scrollTo(0, logEl.current.scrollHeight);
  }, [log]);
  return (
    <pre class="log" ref={logEl}>
      {log.length ? log.map((line, i) => <div key={i}>{linkify(line)}</div>) : <span class="muted">No log yet.</span>}
    </pre>
  );
}

function DiffPane({ task, onError }: { task: Task; onError(message: string): void }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    get<string>(`/api/tasks/${task.id}/diff`).then(setDiff, (e: Error) => onError(e.message));
  }, [task.id, task.state]);
  return (
    <pre class="diff">
      {diff === null
        ? "Loading diff…"
        : diff === ""
          ? "No changes yet."
          : diff.split("\n").map((line, i) => (
              <div key={i} class={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}>
                {line || " "}
              </div>
            ))}
    </pre>
  );
}

/** A scorer proposal as a line diff against the current scorer's rubric, command and plan; reply in the chat to iterate. */
function ProposalDiff({ current, proposal }: { current: ScorerSpec; proposal?: ScorerSpec }) {
  if (!proposal) return <p class="muted small">No scorer proposed; reply in the chat to ask for one.</p>;
  const lines = (spec: ScorerSpec) => JSON.stringify({ rubric: spec.rubric, command: spec.command, plan: spec.plan }, null, 2).split("\n");
  const before = lines(current);
  const after = lines(proposal);
  return (
    <pre class="diff">
      {before.filter((l) => !after.includes(l)).map((l, i) => <div key={`-${i}`} class="del">- {l}</div>)}
      {after.map((l, i) => <div key={i} class={before.includes(l) ? undefined : "add"}>{before.includes(l) ? "  " : "+ "}{l}</div>)}
    </pre>
  );
}

/** The snapshot followed by every shown entry it lacks (events that arrived while it loaded). */
function mergeChat(snapshot: ChatEntry[], shown: ChatEntry[]): ChatEntry[] {
  const key = (e: ChatEntry) => `${e.at}\0${e.role}\0${e.text}`;
  const known = new Set(snapshot.map(key));
  return [...snapshot, ...shown.filter((e) => !known.has(key(e)))];
}

function ChatPane({ task, version, onError }: { task: Task; version: number; onError(message: string): void }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const listEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    get<ChatEntry[]>(`/api/tasks/${task.id}/chat`).then((snapshot) => live && setEntries((shown) => mergeChat(snapshot, shown)), (e: Error) => onError(e.message));
    const unsubscribe = onServerEvent((e) => {
      if (e.type === "chat" && e.taskId === task.id) setEntries((list) => [...list, e.entry]);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [task.id, version]);
  useEffect(() => {
    listEl.current?.scrollTo(0, listEl.current.scrollHeight);
  }, [entries]);
  const blocked = messageBlocked(task);
  const send = (e: Event) => {
    e.preventDefault();
    if (blocked || !text.trim()) return;
    void taskAction(task, "message", onError, { text }).then((ok) => ok && setText(""));
  };
  return (
    <div class="chat">
      <div class="chat-log" ref={listEl}>
        {entries.length ? (
          entries.map((entry, i) => (
            <div key={i} class={`chat-entry ${entry.role}`}>
              <span class="muted small">
                {entry.at.slice(11, 19)} {entry.role}
              </span>{" "}
              {linkify(entry.text)}
            </div>
          ))
        ) : (
          <p class="muted small">No messages yet.</p>
        )}
      </div>
      <form onSubmit={send}>
        <textarea rows={2} value={text} placeholder="Message the agent" onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
        <button type="submit" disabled={Boolean(blocked) || !text.trim()} title={blocked}>
          Send
        </button>
        {blocked && <span class="small muted">{blocked}</span>}
      </form>
    </div>
  );
}

/** A finding's detail and, when it names a file, the code around it at the scored commit. */
function FindingPreview({ finding, open }: { finding: Finding; open: boolean }) {
  const [source, setSource] = useState<ApiSource | "loading" | "failed" | null>(null);
  const load = () => {
    if (source !== null || !finding.file) return;
    setSource("loading");
    const query = `path=${encodeURIComponent(finding.file)}${finding.line ? `&line=${finding.line}` : ""}`;
    get<ApiSource>(`/api/source?${query}`).then(setSource, () => setSource("failed"));
  };
  useEffect(() => {
    if (open) load();
  }, []);
  return (
    <details class="preview" open={open} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && load()}>
      <summary>
        <span class="small muted">{finding.source}</span> {linkify(finding.title)}
      </summary>
      {finding.detail && <p class="small">{linkify(finding.detail)}</p>}
      {finding.file && (
        <div class="small muted">
          {finding.file}
          {finding.line ? `:${finding.line}` : ""}
        </div>
      )}
      {source === "loading" && <div class="small muted">Loading code…</div>}
      {source === "failed" && <div class="small error">Could not load {finding.file}.</div>}
      {source && typeof source === "object" && (
        <pre class="code">
          {source.lines.map((text, i) => {
            const n = source.startLine + i;
            return (
              <div key={n} class={n === finding.line ? "hit" : undefined}>
                <span class="ln">{n}</span>
                {text}
              </div>
            );
          })}
        </pre>
      )}
    </details>
  );
}

/** A suggestion-shaped start for a free-form task at `node`: no findings, no title, an empty prompt. */
function freeTask(node: NodeId): Suggestion {
  return { node, title: "", findingIds: [], impact: { node: 0, root: 0 }, effort: "small", conflict: 0, priority: 0, manualReview: true };
}

export function StartDialog({
  suggestion,
  findings,
  project,
  onClose,
  onError,
}: {
  suggestion: Suggestion;
  findings: Finding[];
  project: string;
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
  const canStart = modelsLoad !== "loading" && prompt.trim() !== "";
  const submit = (e: Event) => {
    e.preventDefault();
    if (!canStart) return;
    const request: StartTaskRequest = {
      node: suggestion.node,
      findingIds: suggestion.findingIds,
      ...(title.trim() && { title }),
      prompt,
      manualReview,
      project,
      ...(model && { model }),
    };
    onClose(); // the task appears in the list via its event; errors surface as a notice
    post<Task>("/api/tasks", request).catch((err: Error) => onError(err.message));
  };
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="dialog" onSubmit={submit}>
        <h3>{suggestion.findingIds.length ? "Start task" : `New task in ${suggestion.node || "the repo root"}`}</h3>
        {findings.length > 0 && (
          <div class="previews">
            {findings.map((f, i) => (
              <FindingPreview key={f.id} finding={f} open={i === 0} />
            ))}
          </div>
        )}
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
          <button type="submit" class="primary" disabled={!canStart}>
            Start
          </button>
        </div>
      </form>
    </div>
  );
}

function defaultPrompt(s: Suggestion, findings: Finding[]): string {
  if (!s.findingIds.length) return "";
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
