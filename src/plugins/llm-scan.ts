import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiOverview, CollectCtx, Effort, Finding, MetricDef, MetricPlugin, MetricValues, NodeId, Severity } from "../types.ts";

/** review_debt points per finding; fixing a finding removes its weight. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 9 };

const KIND = "llm-scan";

/** What a scan looks for, where its results are cached and which metrics and findings it yields. */
export interface ScanKind {
  /** Cache kind of its batch and file entries. */
  kind: string;
  source: string;
  debt: MetricDef;
  loc: MetricDef;
  rubric?: string;
}

/** Quality's LLM scan with the techtree-scan focus areas. */
export const QUALITY_SCAN: ScanKind = {
  kind: KIND,
  source: KIND,
  debt: { key: "review_debt", label: "Review debt", unit: "pts", direction: "lower_better", aggregate: "sum", normalizeBy: "scanned_loc" },
  loc: { key: "scanned_loc", label: "LLM-scanned LOC", unit: "lines", direction: "neutral", aggregate: "sum" },
};

/** A project's rubric scan (DESIGN "Project scorers"); editing the rubric changes its cache kind. */
export function rubricScan(project: string, rubric: string): ScanKind {
  return {
    kind: `rubric:${project}:${sha256(rubric).slice(0, 12)}`,
    source: "rubric",
    debt: { key: "issues", label: "Rubric issues", unit: "pts", direction: "lower_better", aggregate: "sum", normalizeBy: "rubric_loc" },
    loc: { key: "rubric_loc", label: "Rubric-scanned LOC", unit: "lines", direction: "neutral", aggregate: "sum" },
    rubric,
  };
}

const SEVERITIES = Object.keys(SEVERITY_WEIGHT);
const EFFORTS: Effort[] = ["trivial", "small", "medium", "large"];
/** How long a stopped pi child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 1000;
const DEFAULTS = { concurrency: 2, maxFiles: 200, batchFiles: 20, batchBytes: 60_000, timeoutMs: 600_000 };

export interface ScanProgress {
  /** Batches finished, including cached and failed ones. */
  done: number;
  total: number;
  cached: number;
  failed: number;
  findings: number;
}

export type ScanOptions = Partial<typeof DEFAULTS> & {
  onProgress?(progress: ScanProgress): void;
  signal?: AbortSignal;
  /** Default: Quality's scan. */
  scan?: ScanKind;
};

/** A validated model finding as stored in the cache. */
interface ScanItem {
  title: string;
  detail: string;
  file: string;
  line?: number;
  severity: Severity;
  effort: Effort;
  tags: string[];
  metricEffects: Record<string, number>;
}

interface FileEntry {
  sha: string;
  loc: number;
  findings: ScanItem[];
}

interface SourceFile {
  path: string;
  text: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/**
 * Review every file under `node` with the techtree-scan skill and cache the findings by content hash.
 * Failed batches are counted, not thrown; aborting rejects with the signal's reason.
 */
export async function scanNode(node: NodeId, ctx: CollectCtx, opts: ScanOptions = {}): Promise<ScanProgress> {
  const o = { ...DEFAULTS, ...(ctx.config.plugins[KIND] as Partial<typeof DEFAULTS> | undefined), ...opts };
  const { kind, rubric } = opts.scan ?? QUALITY_SCAN;
  const signal = opts.signal ?? ctx.signal;
  const skillDir = findSkillDir();
  const skillText = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const batches = chunk(selectFiles(ctx, node, o), o);
  const progress: ScanProgress = { done: 0, total: batches.length, cached: 0, failed: 0, findings: 0 };

  const scanBatch = async (batch: SourceFile[]) => {
    const key = `batch:${sha256(JSON.stringify([skillText, ...(rubric ? [rubric] : []), batch.map((f) => [f.path, f.text])]))}`;
    let items = ctx.cache.get<ScanItem[]>(kind, key);
    if (items) progress.cached++;
    else {
      try {
        items = parseFindings(await runPiPrint(ctx.config.piCommand, ctx.repoRoot, ["--tools", "read,grep,find,ls", "--skill", skillDir, prompt(batch, rubric)], o.timeoutMs, signal), batch);
        ctx.cache.set(kind, key, items);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        ctx.log(`llm-scan: batch of ${batch.length} files under "${node}" failed: ${(err as Error).message}`);
        progress.failed++;
      }
    }
    if (items) {
      for (const f of batch) {
        const entry: FileEntry = { sha: sha256(f.text), loc: lineCount(f.text), findings: items.filter((i) => i.file === f.path) };
        ctx.cache.set(kind, `file:${f.path}`, entry);
      }
      progress.findings += items.length;
    }
    progress.done++;
    opts.onProgress?.({ ...progress });
  };

  const queue = [...batches];
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      signal?.throwIfAborted();
      await scanBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  return progress;
}

function findSkillDir(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "skills", "techtree-scan");
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    if (dirname(dir) === dir) throw new Error("llm-scan: skills/techtree-scan/SKILL.md not found");
  }
}

function subtreeFiles(ctx: CollectCtx, node: NodeId): string[] {
  const n = ctx.tree.nodes[node];
  return n ? [...n.files, ...n.children.flatMap((c) => subtreeFiles(ctx, c))] : [];
}

function selectFiles(ctx: CollectCtx, node: NodeId, o: typeof DEFAULTS): SourceFile[] {
  const files: SourceFile[] = [];
  for (const path of subtreeFiles(ctx, node).sort()) {
    if (files.length >= o.maxFiles) break;
    const abs = join(ctx.repoRoot, path);
    if (statSync(abs).size > o.batchBytes) continue;
    const text = readFileSync(abs, "utf8");
    if (!text.includes("\0")) files.push({ path, text });
  }
  return files;
}

function chunk(files: SourceFile[], o: typeof DEFAULTS): SourceFile[][] {
  const batches: SourceFile[][] = [];
  let bytes = 0;
  for (const f of files) {
    const last = batches.at(-1);
    const size = Buffer.byteLength(f.text);
    if (last && last.length < o.batchFiles && bytes + size <= o.batchBytes) {
      last.push(f);
      bytes += size;
    } else {
      batches.push([f]);
      bytes = size;
    }
  }
  return batches;
}

/** Replaces the skill's focus areas with a project rubric; the output format stays the same. */
function rubricPreamble(rubric: string): string {
  return `Rubric: ${rubric}\nReport only issues this rubric describes, instead of the skill's focus areas; keep the output format.`;
}

function prompt(batch: SourceFile[], rubric?: string): string {
  const numbered = (text: string) =>
    text
      .split("\n")
      .slice(0, lineCount(text))
      .map((line, i) => `${i + 1}: ${line}`)
      .join("\n");
  return `/skill:techtree-scan ${rubric ? `${rubricPreamble(rubric)}\n\n` : ""}Review these files:\n\n${batch.map((f) => `=== ${f.path} ===\n${numbered(f.text)}`).join("\n\n")}`;
}

/** Run `<piCommand> -p --no-session <args>` in `cwd` and resolve its stdout; a nonzero exit, timeout or abort rejects. */
export function runPiPrint(piCommand: string[], cwd: string, args: string[], timeout: number, signal?: AbortSignal, options: { input?: string; maxOutputBytes?: number } = {}): Promise<string> {
  const [cmd, ...prefix] = piCommand;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, "-p", "--no-session", ...args], { cwd, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const accept = (data: string) => {
      outputBytes += Buffer.byteLength(data);
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        stop(new Error(`pi output exceeded ${options.maxOutputBytes} bytes`));
        return false;
      }
      return true;
    };
    child.stdout!.setEncoding("utf8").on("data", (d: string) => { if (accept(d)) stdout += d; });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => { if (accept(d)) stderr += d; });
    let stopReason: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: unknown) => {
      if (stopReason !== undefined) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop(new Error(`pi timed out after ${timeout}ms`)), timeout);
    const onAbort = () => stop(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdin?.on("error", stop);
    if (options.input !== undefined) child.stdin!.end(options.input);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code, killedBy) => {
      cleanup();
      if (stopReason !== undefined) reject(stopReason);
      else if (code === 0) resolve(stdout);
      else reject(new Error(`pi exited with ${killedBy ?? code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

/** Extract the JSON array from the model's reply and keep only well-formed findings about `batch` files. */
function parseFindings(output: string, batch: SourceFile[]): ScanItem[] {
  const parsed = parseJsonArray(output);
  if (!parsed) throw new Error(`no JSON array in output: ${output.trim().slice(0, 200)}`);
  const paths = new Set(batch.map((f) => f.path));
  const seen = new Set<string>();
  return parsed.flatMap((raw): ScanItem[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const r = raw as Record<string, unknown>;
    const valid =
      typeof r.title === "string" &&
      r.title.trim() !== "" &&
      typeof r.detail === "string" &&
      typeof r.file === "string" &&
      paths.has(r.file) &&
      SEVERITIES.includes(r.severity as string) &&
      EFFORTS.includes(r.effort as Effort) &&
      (r.line === undefined || (Number.isInteger(r.line) && (r.line as number) > 0));
    if (!valid) return [];
    const identity = JSON.stringify([r.file, (r.title as string).trim()]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    const fix = typeof r.suggestedFix === "string" && r.suggestedFix.trim() ? `\n\nSuggested fix: ${r.suggestedFix.trim()}` : "";
    const effects = typeof r.metricEffects === "object" && r.metricEffects !== null ? r.metricEffects : {};
    return [
      {
        title: (r.title as string).trim(),
        detail: (r.detail as string).trim() + fix,
        file: r.file as string,
        ...(r.line === undefined ? {} : { line: r.line as number }),
        severity: r.severity as Severity,
        effort: r.effort as Effort,
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
        metricEffects: Object.fromEntries(
          Object.entries(effects).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])),
        ),
      },
    ];
  });
}

function parseJsonArray(output: string): unknown[] | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(output)?.[1];
  const bracketed = output.slice(output.indexOf("["), output.lastIndexOf("]") + 1);
  for (const candidate of [output.trim(), fenced, bracketed]) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch {}
  }
  return undefined;
}

/** Cached scan results for `path`, if its current contents are the ones that were scanned. */
function freshEntry(ctx: CollectCtx, kind: string, path: string): FileEntry | undefined {
  const entry = ctx.cache.get<FileEntry>(kind, `file:${path}`);
  if (!entry) return undefined;
  try {
    return sha256(readFileSync(join(ctx.repoRoot, path), "utf8")) === entry.sha ? entry : undefined;
  } catch {
    return undefined;
  }
}

function scannedNodeEntries(ctx: CollectCtx, kind: string): [NodeId, FileEntry[]][] {
  return Object.values(ctx.tree.nodes)
    .map((n): [NodeId, FileEntry[]] => [n.id, n.files.flatMap((p) => freshEntry(ctx, kind, p) ?? [])])
    .filter(([, entries]) => entries.length > 0);
}

/** Overview scan coverage: nodes with any scanned own file, and scanned vs total lines. */
export function scanCoverage(ctx: CollectCtx, scan: ScanKind = QUALITY_SCAN): ApiOverview["coverage"] {
  const files = Object.values(ctx.tree.nodes).flatMap((n) => n.files);
  const totalLoc = files.reduce((sum, p) => {
    try {
      return sum + lineCount(readFileSync(join(ctx.repoRoot, p), "utf8"));
    } catch {
      return sum;
    }
  }, 0);
  const scanned = scannedNodeEntries(ctx, scan.kind);
  return {
    scannedNodes: scanned.length,
    totalNodes: Object.keys(ctx.tree.nodes).length,
    scannedLoc: scanned.reduce((sum, [, entries]) => sum + entries.reduce((s, e) => s + e.loc, 0), 0),
    totalLoc,
  };
}

/** On-demand LLM review results of `scan`; scoring reads only the cache filled by `scanNode`. */
export function scanPlugin(scan: ScanKind): MetricPlugin {
  const { debt, loc } = scan;
  return {
    id: scan.source,
    metrics: [debt, loc],
    async collect(ctx): Promise<MetricValues> {
      const values: MetricValues = {};
      for (const [node, entries] of scannedNodeEntries(ctx, scan.kind)) {
        const items = entries.flatMap((e) => e.findings);
        values[node] = {
          [debt.key]: items.reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0),
          [loc.key]: entries.reduce((sum, e) => sum + e.loc, 0),
        };
      }
      return values;
    },
    async findings(ctx): Promise<Finding[]> {
      return scannedNodeEntries(ctx, scan.kind).flatMap(([node, entries]) =>
        entries
          .flatMap((e) => e.findings)
          .map(({ metricEffects, ...item }) => ({
            ...item,
            id: sha256(JSON.stringify([scan.kind, item.file, item.title])).slice(0, 16),
            node,
            source: scan.source,
            metricEffects: { ...metricEffects, [debt.key]: -SEVERITY_WEIGHT[item.severity] },
          })),
      );
    },
  };
}

export const llmScanPlugin = scanPlugin(QUALITY_SCAN);
