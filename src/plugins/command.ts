import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Aggregate, CollectCtx, Direction, Effort, Finding, MetricDef, MetricPlugin, MetricValues, NodeId, Severity, Tree } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 1000;
const DIRECTIONS: Direction[] = ["higher_better", "lower_better", "neutral"];
const AGGREGATES: Aggregate[] = ["sum", "max", "mean_by_loc"];
const SEVERITIES: Severity[] = ["low", "medium", "high"];
const EFFORTS: Effort[] = ["trivial", "small", "medium", "large"];

interface CommandOutput {
  metrics: MetricDef[];
  values: MetricValues;
  findings: Finding[];
}

/**
 * A project's command scorer (DESIGN "Project scorers"): runs `argv` in the repo root once per
 * scoring run and turns its JSON into metrics and findings. A failed run throws, so the pipeline
 * logs it and drops the plugin's output.
 */
export function commandPlugin(project: string, argv: string[]): MetricPlugin {
  let output: Promise<CommandOutput> | undefined;
  const run = (ctx: CollectCtx) =>
    (output ??= runCommand(argv, ctx).then((stdout) => parseOutput(stdout, ctx.tree, project)));
  const plugin: MetricPlugin = {
    id: "command",
    metrics: [],
    async collect(ctx) {
      const { metrics, values } = await run(ctx);
      plugin.metrics = metrics;
      return values;
    },
    async findings(ctx) {
      return (await run(ctx)).findings;
    },
  };
  return plugin;
}

function runCommand(argv: string[], ctx: CollectCtx): Promise<string> {
  const timeout = Number(ctx.config.plugins.command?.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also stops the benchmarks a wrapper script started.
    const child = spawn(cmd, args, { cwd: ctx.repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (err: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (err) reject(err);
      else resolve(stdout);
    };
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // the group is already gone
      }
    };
    const timer = setTimeout(() => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        settle(new Error(`${cmd} timed out after ${timeout}ms`));
      }, KILL_GRACE_MS);
    }, timeout);
    const lastStderr = () => stderr.trim().split("\n").at(-1) ?? "";
    child.on("error", (err) => settle(new Error(`${cmd} could not start: ${err.message}`)));
    child.on("close", (code, signal) => {
      if (killTimer) return settle(new Error(`${cmd} timed out after ${timeout}ms`));
      if (code !== 0) return settle(new Error(`${cmd} exited with ${signal ?? code}${lastStderr() ? `: ${lastStderr()}` : ""}`));
      settle(undefined);
    });
  });
}

function parseOutput(stdout: string, tree: Tree, project: string): CommandOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`output is not JSON: ${stdout.trim().slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("output must be a JSON object");
  const raw = parsed as { metrics?: unknown; values?: unknown; findings?: unknown };
  if (!Array.isArray(raw.metrics)) throw new Error("output needs a metrics list");
  const metrics = raw.metrics.flatMap((m): MetricDef[] => {
    const r = m as Record<string, unknown>;
    const valid =
      typeof r?.key === "string" && r.key !== "" && typeof r.label === "string" && r.label !== "" && DIRECTIONS.includes(r.direction as Direction);
    if (!valid) return [];
    const aggregate = AGGREGATES.includes(r.aggregate as Aggregate) ? (r.aggregate as Aggregate) : "sum";
    return [{ key: r.key as string, label: r.label as string, direction: r.direction as Direction, aggregate, ...(typeof r.unit === "string" && { unit: r.unit }) }];
  });
  return { metrics, values: collectValues(raw.values, metrics, tree), findings: withDefaultEffects(collectFindings(raw.findings, tree, project, metrics), raw.values, metrics) };
}

/** Per-node values: a file's values count for its directory; repeats combine with the metric's aggregate. */
function collectValues(raw: unknown, metrics: MetricDef[], tree: Tree): MetricValues {
  const defs = new Map(metrics.map((d) => [d.key, d]));
  const seen = new Map<string, number[]>();
  for (const [path, entry] of Object.entries(typeof raw === "object" && raw !== null ? raw : {})) {
    const node = nodeOf(path, tree);
    if (node === undefined || typeof entry !== "object" || entry === null) continue;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!defs.has(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
      const id = JSON.stringify([node, key]);
      seen.set(id, [...(seen.get(id) ?? []), value]);
    }
  }
  const values: MetricValues = {};
  for (const [id, list] of seen) {
    const [node, key] = JSON.parse(id) as [NodeId, string];
    const aggregate = defs.get(key)!.aggregate;
    const combined =
      aggregate === "max" ? Math.max(...list) : aggregate === "sum" ? list.reduce((a, b) => a + b, 0) : list.reduce((a, b) => a + b, 0) / list.length;
    (values[node] ??= {})[key] = combined;
  }
  return values;
}

function collectFindings(raw: unknown, tree: Tree, project: string, metrics: MetricDef[]): Finding[] {
  const keys = new Set(metrics.map((d) => d.key));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f): Finding[] => {
    const r = f as Record<string, unknown>;
    if (typeof r?.title !== "string" || !r.title.trim() || !SEVERITIES.includes(r.severity as Severity)) return [];
    const file = typeof r.file === "string" ? r.file : undefined;
    const node = typeof r.node === "string" ? nodeOf(r.node, tree) : file !== undefined ? nodeOf(file, tree) : undefined;
    if (node === undefined) return [];
    const title = r.title.trim();
    return [
      {
        id: createHash("sha256").update(JSON.stringify(["command", project, file ?? node, title])).digest("hex").slice(0, 16),
        node,
        ...(file !== undefined && { file }),
        ...(Number.isInteger(r.line) && (r.line as number) > 0 && { line: r.line as number }),
        source: "command",
        title,
        detail: typeof r.detail === "string" ? r.detail : "",
        severity: r.severity as Severity,
        effort: EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort) : "small",
        metricEffects: Object.fromEntries(
          Object.entries(typeof r.metricEffects === "object" && r.metricEffects !== null ? r.metricEffects : {}).filter(
            ([key, value]) => keys.has(key) && typeof value === "number" && Number.isFinite(value),
          ),
        ),
      },
    ];
  });
}

/** Findings without effects of their own: an even share of each `lower_better` value at their file (else node) path, negated. */
function withDefaultEffects(findings: Finding[], rawValues: unknown, metrics: MetricDef[]): Finding[] {
  const values = (typeof rawValues === "object" && rawValues !== null ? rawValues : {}) as Record<string, Record<string, unknown>>;
  const lower = metrics.filter((d) => d.direction === "lower_better").map((d) => d.key);
  const pathOf = (f: Finding) => (f.file !== undefined && Object.hasOwn(values, f.file) ? f.file : f.node);
  const perPath = new Map<string, number>();
  for (const f of findings) perPath.set(pathOf(f), (perPath.get(pathOf(f)) ?? 0) + 1);
  return findings.map((f) => {
    if (Object.keys(f.metricEffects).length) return f;
    const at = Object.hasOwn(values, pathOf(f)) ? values[pathOf(f)] : {};
    const effects = lower.flatMap((key) => {
      const value = at?.[key];
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? [[key, -value / perPath.get(pathOf(f))!]] : [];
    });
    return { ...f, metricEffects: Object.fromEntries(effects) };
  });
}

/** The node of a directory path, or of a file's directory (deepest existing ancestor); undefined for unknown paths. */
function nodeOf(path: string, tree: Tree): NodeId | undefined {
  const clean = path.replace(/^\.\/|\/+$/g, "");
  if (Object.hasOwn(tree.nodes, clean)) return clean;
  const isFile = Object.values(tree.nodes).some((n) => n.files.includes(clean));
  if (!isFile) return undefined;
  for (let dir = clean; ; ) {
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (Object.hasOwn(tree.nodes, dir)) return dir;
  }
}
