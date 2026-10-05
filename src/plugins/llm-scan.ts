import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiOverview, CollectCtx, Effort, Finding, MetricPlugin, MetricValues, NodeId, Severity } from "../types.ts";

/** review_debt points per finding; fixing a finding removes its weight. */
export const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 9 };

const KIND = "llm-scan";
const SEVERITIES = Object.keys(SEVERITY_WEIGHT);
const EFFORTS: Effort[] = ["trivial", "small", "medium", "large"];
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
  const signal = opts.signal ?? ctx.signal;
  const skillDir = findSkillDir();
  const skillText = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const batches = chunk(selectFiles(ctx, node, o), o);
  const progress: ScanProgress = { done: 0, total: batches.length, cached: 0, failed: 0, findings: 0 };

  const scanBatch = async (batch: SourceFile[]) => {
    const key = `batch:${sha256(JSON.stringify([skillText, batch.map((f) => [f.path, f.text])]))}`;
    let items = ctx.cache.get<ScanItem[]>(KIND, key);
    if (items) progress.cached++;
    else {
      try {
        items = parseFindings(await runPi(ctx, skillDir, batch, o.timeoutMs, signal), batch);
        ctx.cache.set(KIND, key, items);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        ctx.log(`llm-scan: batch of ${batch.length} files under "${node}" failed: ${(err as Error).message}`);
        progress.failed++;
      }
    }
    if (items) {
      for (const f of batch) {
        const entry: FileEntry = { sha: sha256(f.text), loc: lineCount(f.text), findings: items.filter((i) => i.file === f.path) };
        ctx.cache.set(KIND, `file:${f.path}`, entry);
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
    if (last && last.length < o.batchFiles && bytes + f.text.length <= o.batchBytes) {
      last.push(f);
      bytes += f.text.length;
    } else {
      batches.push([f]);
      bytes = f.text.length;
    }
  }
  return batches;
}

function prompt(batch: SourceFile[]): string {
  const numbered = (text: string) =>
    text
      .split("\n")
      .slice(0, lineCount(text))
      .map((line, i) => `${i + 1}: ${line}`)
      .join("\n");
  return `/skill:techtree-scan Review these files:\n\n${batch.map((f) => `=== ${f.path} ===\n${numbered(f.text)}`).join("\n\n")}`;
}

function runPi(ctx: CollectCtx, skillDir: string, batch: SourceFile[], timeout: number, signal?: AbortSignal): Promise<string> {
  const [cmd, ...prefix] = ctx.config.piCommand;
  const args = [...prefix, "-p", "--no-session", "--tools", "read,grep,find,ls", "--skill", skillDir, prompt(batch)];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ctx.repoRoot, stdio: ["ignore", "pipe", "pipe"], timeout, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`pi exited with ${killedBy ?? code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

/** Extract the JSON array from the model's reply and keep only well-formed findings about `batch` files. */
function parseFindings(output: string, batch: SourceFile[]): ScanItem[] {
  const parsed = parseJsonArray(output);
  if (!parsed) throw new Error(`no JSON array in output: ${output.trim().slice(0, 200)}`);
  const paths = new Set(batch.map((f) => f.path));
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
function freshEntry(ctx: CollectCtx, path: string): FileEntry | undefined {
  const entry = ctx.cache.get<FileEntry>(KIND, `file:${path}`);
  if (!entry) return undefined;
  try {
    return sha256(readFileSync(join(ctx.repoRoot, path), "utf8")) === entry.sha ? entry : undefined;
  } catch {
    return undefined;
  }
}

function scannedNodeEntries(ctx: CollectCtx): [NodeId, FileEntry[]][] {
  return Object.values(ctx.tree.nodes)
    .map((n): [NodeId, FileEntry[]] => [n.id, n.files.flatMap((p) => freshEntry(ctx, p) ?? [])])
    .filter(([, entries]) => entries.length > 0);
}

/** Overview scan coverage: nodes with any scanned own file, and scanned vs total lines. */
export function scanCoverage(ctx: CollectCtx): ApiOverview["coverage"] {
  const files = Object.values(ctx.tree.nodes).flatMap((n) => n.files);
  const totalLoc = files.reduce((sum, p) => {
    try {
      return sum + lineCount(readFileSync(join(ctx.repoRoot, p), "utf8"));
    } catch {
      return sum;
    }
  }, 0);
  const scanned = scannedNodeEntries(ctx);
  return {
    scannedNodes: scanned.length,
    totalNodes: Object.keys(ctx.tree.nodes).length,
    scannedLoc: scanned.reduce((sum, [, entries]) => sum + entries.reduce((s, e) => s + e.loc, 0), 0),
    totalLoc,
  };
}

/** On-demand LLM review results; scoring reads only the cache filled by `scanNode`. */
export const llmScanPlugin: MetricPlugin = {
  id: KIND,
  metrics: [
    { key: "review_debt", label: "Review debt", unit: "pts", direction: "lower_better", aggregate: "sum", normalizeBy: "scanned_loc" },
    { key: "scanned_loc", label: "LLM-scanned LOC", unit: "lines", direction: "neutral", aggregate: "sum" },
  ],
  async collect(ctx): Promise<MetricValues> {
    const values: MetricValues = {};
    for (const [node, entries] of scannedNodeEntries(ctx)) {
      const items = entries.flatMap((e) => e.findings);
      values[node] = {
        review_debt: items.reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0),
        scanned_loc: entries.reduce((sum, e) => sum + e.loc, 0),
      };
    }
    return values;
  },
  async findings(ctx): Promise<Finding[]> {
    const byId = new Map<string, Finding>();
    for (const [node, entries] of scannedNodeEntries(ctx)) {
      for (const { metricEffects, ...item } of entries.flatMap((e) => e.findings)) {
        const id = sha256(JSON.stringify([KIND, item.file, item.title])).slice(0, 16);
        byId.set(id, {
          ...item,
          id,
          node,
          source: KIND,
          metricEffects: { ...metricEffects, review_debt: -SEVERITY_WEIGHT[item.severity] },
        });
      }
    }
    return [...byId.values()];
  },
};
