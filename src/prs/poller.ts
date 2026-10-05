import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { dbCache, type Db } from "../db.ts";
import type { Cache, CiState, PrState, ServerEvent, Task, Tree } from "../types.ts";
import { anchorPr } from "./anchor.ts";

export interface PrPollerOptions {
  db: Db;
  repoRoot: string;
  /** argv prefix for the GitHub CLI; default `["gh"]`. */
  gh?: string[];
  /** Latest scored tree, used to anchor PRs (root when absent). */
  tree?: () => Tree | undefined;
  /** Current tasks, used to link PRs and to poll task PRs not authored by the current user. */
  tasks?: () => Task[];
  intervalMs?: number;
  maxBackoffMs?: number;
  /** Clock in epoch milliseconds. */
  now?: () => number;
  onEvent?: (event: ServerEvent) => void;
  /** Called for every open PR after each successful poll; `prev` is undefined for a PR seen for the first time. */
  onUpdate?: (prev: PrState | undefined, next: PrState) => void;
  /** Called for a PR that left the open list (merged or closed). */
  onRemove?: (pr: PrState) => void;
}

interface Staged {
  prev: PrState | undefined;
  row: Row;
}

interface Row {
  pr: PrState;
  fixAttempts: number;
  lastProgressAt: string;
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  author: { login: string } | null;
  files: { path: string; additions: number; deletions: number }[] | null;
  statusCheckRollup: GhCheck[] | null;
  reviewDecision: string | null;
  reviews: { author: { login: string } | null; state: string }[] | null;
  updatedAt: string;
  mergeable: PrState["mergeable"];
  headRefName: string;
  headRefOid: string;
  state: string;
}

type GhCheck =
  | { __typename: "CheckRun"; status: string; conclusion: string }
  | { __typename: "StatusContext"; state: string };

const FIELDS =
  "number,url,title,author,files,statusCheckRollup,reviewDecision,reviews,updatedAt,mergeable,headRefName,headRefOid,state";
const FAILED_CONCLUSIONS = ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const HOUR = 3600 * 1000;
const STUCK_AFTER_MS = 24 * HOUR;
const STALE_AFTER_MS = 72 * HOUR;
const GH_TIMEOUT_MS = 60_000;
/** Cache kind marking PR numbers known to be merged or closed. */
const RETIRED = "pr-retired";

/** Polls `gh` for the repo's open PRs and keeps the `prs` table current. See docs/DESIGN.md "PRs". */
export class PrPoller {
  /** `ok` after a successful poll, else what went wrong. */
  status = "not polled yet";
  /** Login of the current gh user, once known. */
  user: string | undefined;
  /** Delay before the next scheduled poll; grows while gh keeps failing. */
  delayMs: number;
  private readonly opts: PrPollerOptions;
  private readonly rows = new Map<number, Row>();
  private readonly cache: Cache;
  private failures = 0;
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(opts: PrPollerOptions) {
    this.opts = opts;
    this.cache = dbCache(opts.db);
    this.delayMs = this.interval();
    const rows = opts.db.prepare("SELECT data, fix_attempts, last_progress_at FROM prs ORDER BY number").all() as {
      data: string;
      fix_attempts: number;
      last_progress_at: string;
    }[];
    for (const r of rows) {
      const pr = JSON.parse(r.data) as PrState;
      this.rows.set(pr.number, { pr, fixAttempts: r.fix_attempts, lastProgressAt: r.last_progress_at });
    }
  }

  list(): PrState[] {
    return [...this.rows.values()].map((r) => r.pr).sort((a, b) => a.number - b.number);
  }

  get(number: number): PrState | undefined {
    return this.rows.get(number)?.pr;
  }

  fixAttempts(number: number): number {
    return this.rows.get(number)?.fixAttempts ?? 0;
  }

  /** Change a known PR's local fields (babysit state), persist it and emit a `pr` event. */
  update(number: number, patch: Partial<PrState>, fixAttempts?: number): PrState {
    const row = this.rows.get(number);
    if (!row) throw new Error(`unknown PR #${number}`);
    Object.assign(row.pr, patch);
    if (fixAttempts !== undefined) row.fixAttempts = fixAttempts;
    this.save(row);
    this.opts.onEvent?.({ type: "pr", pr: row.pr });
    return row.pr;
  }

  /** Poll now and then every `delayMs` until `stop()`. */
  start(): void {
    this.polling = true;
    void this.tick();
  }

  stop(): void {
    this.polling = false;
    clearTimeout(this.timer);
  }

  /** Poll once; a call while a poll is running joins it. Never rejects. */
  poll(): Promise<void> {
    this.running ??= this.pollOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async tick(): Promise<void> {
    await this.poll();
    if (this.polling) this.timer = setTimeout(() => void this.tick(), this.delayMs);
  }

  private interval(): number {
    return this.opts.intervalMs ?? 60_000;
  }

  /** Look the current gh user up again; undefined when gh cannot tell. Babysit calls this before acting on a toggle. */
  async refreshUser(): Promise<string | undefined> {
    this.user = undefined;
    this.user = await this.lookupUser().catch(() => undefined);
    return this.user;
  }

  private async lookupUser(): Promise<string> {
    const login = (await this.gh("api", "user", "--jq", ".login")).trim();
    if (!login) throw new Error("gh api user returned no login");
    return login;
  }

  private async pollOnce(): Promise<void> {
    let staged: Staged[];
    try {
      this.user = undefined;
      this.user = await this.lookupUser();
      const prs = parseList(await this.gh("pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", FIELDS));
      for (const number of this.taskPrNumbers().filter((n) => !prs.some((p) => p.number === n))) {
        const [pr] = parseList(`[${await this.gh("pr", "view", String(number), "--json", FIELDS)}]`);
        if (pr.state === "OPEN") prs.push(pr);
        else this.retire(number);
      }
      staged = this.stage(prs);
    } catch (err) {
      this.failures++;
      this.status = `gh failed: ${errorLine(err)}`;
      this.delayMs = Math.min(this.interval() * 2 ** this.failures, this.opts.maxBackoffMs ?? 15 * 60_000);
      return;
    }
    this.failures = 0;
    this.status = "ok";
    this.delayMs = this.interval();
    this.commit(staged);
  }

  /** Task PRs still worth a `gh pr view`: on a `pr_open` task and not known to be merged or closed. */
  private taskPrNumbers(): number[] {
    const tasks = this.opts.tasks?.() ?? [];
    const numbers = tasks.filter((t) => t.state === "pr_open" && t.pr !== undefined).map((t) => t.pr!);
    return [...new Set(numbers)].filter((n) => !this.cache.get(RETIRED, String(n)));
  }

  private retire(number: number): void {
    this.cache.set(RETIRED, String(number), true);
  }

  private stage(prs: GhPr[]): Staged[] {
    const now = this.opts.now?.() ?? Date.now();
    const tree = this.opts.tree?.();
    const tasks = this.opts.tasks?.() ?? [];
    return prs.map((gh) => {
      const old = this.rows.get(gh.number);
      const prev = old && structuredClone(old.pr);
      const pr = toPrState(gh, tree, tasks, prev);
      const progressed =
        prev && (prev.head !== pr.head || prev.ci !== pr.ci || prev.review !== pr.review || prev.reviewCount !== pr.reviewCount);
      const lastProgressAt = !old ? pr.updatedAt : progressed ? new Date(now).toISOString() : old.lastProgressAt;
      pr.stale = now - Date.parse(pr.updatedAt) >= STALE_AFTER_MS;
      pr.stuck = now - Date.parse(lastProgressAt) >= STUCK_AFTER_MS;
      return { prev, row: { pr, fixAttempts: old?.fixAttempts ?? 0, lastProgressAt } };
    });
  }

  private commit(staged: Staged[]): void {
    for (const { prev, row } of staged) {
      this.rows.set(row.pr.number, row);
      this.save(row);
      if (!isDeepStrictEqual(prev, row.pr)) this.opts.onEvent?.({ type: "pr", pr: row.pr });
    }
    for (const [number, { pr }] of this.rows) {
      if (staged.some((s) => s.row.pr.number === number)) continue;
      this.rows.delete(number);
      this.opts.db.prepare("DELETE FROM prs WHERE number = ?").run(number);
      this.retire(number);
      this.opts.onEvent?.({ type: "pr_removed", number });
      this.opts.onRemove?.(pr);
    }
    for (const { prev, row } of staged) this.opts.onUpdate?.(prev, row.pr);
  }

  private save(row: Row): void {
    this.opts.db
      .prepare(
        "INSERT INTO prs (number, data, fix_attempts, last_progress_at) VALUES (?, ?, ?, ?) ON CONFLICT (number) DO UPDATE " +
          "SET data = excluded.data, fix_attempts = excluded.fix_attempts, last_progress_at = excluded.last_progress_at",
      )
      .run(row.pr.number, JSON.stringify(row.pr), row.fixAttempts, row.lastProgressAt);
  }

  private async gh(...args: string[]): Promise<string> {
    const [command, ...prefix] = this.opts.gh ?? ["gh"];
    const { stdout } = await promisify(execFile)(command, [...prefix, ...args], {
      cwd: this.opts.repoRoot,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
}

function parseList(stdout: string): GhPr[] {
  const prs = JSON.parse(stdout) as unknown;
  if (!Array.isArray(prs)) throw new Error("gh did not return a list of PRs");
  if (!prs.every((p) => typeof p?.number === "number")) throw new Error("gh returned a malformed PR");
  return prs as GhPr[];
}

function toPrState(gh: GhPr, tree: Tree | undefined, tasks: Task[], prev: PrState | undefined): PrState {
  const author = gh.author?.login ?? "";
  const files = gh.files ?? [];
  const task = tasks
    .filter((t) => t.pr === gh.number || t.branch === gh.headRefName)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const pr: PrState = {
    number: gh.number,
    url: gh.url,
    title: gh.title,
    author,
    node: tree ? anchorPr(files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })), tree) : "",
    files: files.map((f) => f.path),
    ci: ciState(gh.statusCheckRollup ?? []),
    review: gh.reviewDecision ?? "",
    updatedAt: gh.updatedAt,
    babysit: prev?.babysit ?? false,
    stale: false,
    stuck: false,
    mergeable: gh.mergeable,
    branch: gh.headRefName,
    head: gh.headRefOid,
    reviewCount: (gh.reviews ?? []).filter((r) => r.state !== "APPROVED" && r.author?.login !== author).length,
  };
  if (task) pr.taskId = task.id;
  if (prev?.babysitStatus !== undefined) pr.babysitStatus = prev.babysitStatus;
  return pr;
}

function ciState(rollup: GhCheck[]): CiState {
  const failed = (c: GhCheck) =>
    c.__typename === "CheckRun" ? FAILED_CONCLUSIONS.includes(c.conclusion) : c.state === "FAILURE" || c.state === "ERROR";
  const pending = (c: GhCheck) =>
    c.__typename === "CheckRun" ? c.status !== "COMPLETED" : c.state === "PENDING" || c.state === "EXPECTED";
  if (rollup.some(failed)) return "fail";
  if (rollup.some(pending)) return "pending";
  return "pass";
}

function errorLine(err: unknown): string {
  const { stderr, message } = err as { stderr?: string; message?: string };
  const text = stderr?.trim() || message || String(err);
  return text.split("\n")[0];
}
