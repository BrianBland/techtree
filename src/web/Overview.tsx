import { useEffect, useState } from "preact/hooks";
import type { ApiOverview, ApiState, NodeId, Suggestion } from "../types.ts";
import { get } from "./api.ts";
import { linkify } from "./linkify.ts";
import { PrRow, Section, SuggestionRow, attentionKey, fmt } from "./Panel.tsx";

export interface OverviewProps {
  state: ApiState;
  /** Bumped when scores change or the event stream reconnects. */
  version: number;
  onSelect(id: NodeId): void;
  onStart(suggestion: Suggestion): void;
  onError(message: string): void;
}

export function Overview({ state, version, onSelect, onStart, onError }: OverviewProps) {
  const [overview, setOverview] = useState<ApiOverview | null>(null);

  useEffect(() => {
    get<ApiOverview>("/api/overview").then(setOverview, (e: Error) => onError(e.message));
  }, [attentionKey(state), version]);

  if (!overview) return <aside class="panel muted">Loading…</aside>;
  const nodeName = (id: NodeId) => (id === "" ? state.repo.name : id);
  const { coverage } = overview;
  return (
    <aside class="panel">
      <header>
        <div>
          <h2>{state.repo.name}</h2>
          <div class="muted">{state.snapshot ? `scored at ${state.snapshot.sha.slice(0, 8)}` : "not scored yet"}</div>
        </div>
        <div class="score-big">{fmt(state.scores[""]?.quality)}</div>
      </header>
      {!overview.attentionTasks.length && !overview.flaggedPrs.length && <p class="muted">Nothing needs your attention.</p>}
      <Section title="Needs you" items={overview.attentionTasks}>
        {(task) => (
          <li key={task.id} class="row clickable" onClick={() => onSelect(task.node)}>
            <div>
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
      <Section title="Pull requests needing attention" items={overview.flaggedPrs}>
        {(pr) => <PrRow key={pr.number} pr={pr} onError={onError} />}
      </Section>
      <Section title="Top suggestions" items={overview.suggestions}>
        {(s) => (
          <li key={s.node + s.title}>
            <SuggestionRow suggestion={s} onStart={() => onStart(s)} />
            <button class="link small" onClick={() => onSelect(s.node)}>
              {nodeName(s.node)}
            </button>
          </li>
        )}
      </Section>
      <section>
        <h3>Scan coverage</h3>
        <p class="small">
          {coverage.scannedNodes} of {coverage.totalNodes} directories, {pct(coverage.scannedLoc, coverage.totalLoc)} of lines scanned
        </p>
        <div class="meter">
          <div style={{ width: pct(coverage.scannedLoc, coverage.totalLoc) }} />
        </div>
      </section>
    </aside>
  );
}

function pct(part: number, total: number): string {
  return `${total ? Math.round((part / total) * 100) : 0}%`;
}
