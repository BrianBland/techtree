import { statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureServer, type ServerInfo } from "../src/backend/launch.ts";
import { cacheDir, repoId, repoRootOf } from "../src/paths.ts";
import { techtreeReportTool } from "../src/runner/report-tool.ts";
import type { ApiNode, ApiOverview, ApiState, NodeId, ServerEvent, Task } from "../src/types.ts";

const WIDGET = "techtree";
const RECONNECT_MS = 5000;
const DEFAULT_FINDINGS = 10;

/** techtree pi extension; see docs/DESIGN.md "pi extension". Its factory starts nothing. */
export default function techtree(pi: ExtensionAPI): void {
  if (process.env.TECHTREE_TASK) {
    pi.registerTool(techtreeReportTool);
    return;
  }
  let widget: AbortController | undefined;

  pi.registerCommand("techtree", {
    description: "Open the techtree web UI for this repository (starts its server if needed)",
    handler: async (_args, ctx) => {
      const { server } = await connect(ctx.cwd);
      ctx.ui.notify(`techtree: ${server.url}`, "warning");
      if (ctx.mode === "print") process.stdout.write(`${server.url}\n`);
      widget?.abort();
      widget = new AbortController();
      void runWidget(ctx, server, widget.signal);
    },
  });

  pi.registerTool({
    name: "techtree_status",
    label: "techtree status",
    description: "techtree overview of this repository: root quality score, running tasks, items needing attention, web UI URL.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const { server } = await connect(ctx.cwd);
      const [state, overview] = await Promise.all([
        api<ApiState>(server, "/api/state", signal),
        api<ApiOverview>(server, "/api/overview", signal),
      ]);
      return text(statusReport(server, state, overview));
    },
  });

  pi.registerTool({
    name: "techtree_findings",
    label: "techtree findings",
    description:
      "Top techtree findings (lint, test gaps, review issues…) ranked by estimated quality impact, " +
      "for the deepest scored directory containing a path.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "File or directory, repo-relative or absolute; defaults to the working directory" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: `Number of findings (default ${DEFAULT_FINDINGS})` })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { repoRoot, server } = await connect(ctx.cwd);
      const absolute = params.path ? resolve(repoRoot, params.path) : ctx.cwd;
      let id = nodeIdOf(repoRoot, absolute);
      let node: ApiNode | undefined;
      while (!(node = await api<ApiNode | undefined>(server, `/api/node?id=${encodeURIComponent(id)}`, signal, true))) {
        if (id === "") throw new Error("techtree has no score for the repository root yet");
        id = parentOf(id);
      }
      return text(findingsReport(id, node, params.limit ?? DEFAULT_FINDINGS));
    },
  });

  pi.on("session_shutdown", () => {
    widget?.abort();
    widget = undefined;
  });
}

async function connect(cwd: string): Promise<{ repoRoot: string; server: ServerInfo }> {
  let repoRoot: string;
  try {
    repoRoot = repoRootOf(cwd);
  } catch {
    throw new Error(`techtree: ${cwd} is not inside a git repository`);
  }
  return { repoRoot, server: await ensureServer(repoRoot, cacheDir(repoId(repoRoot))) };
}

/** GET an API route; with `allow404`, a 404 yields undefined instead of an error. */
async function api<T>(server: ServerInfo, path: string, signal?: AbortSignal, allow404 = false): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: authorization(server), signal });
  if (allow404 && res.status === 404) return undefined as T;
  if (!res.ok) throw new Error(`techtree ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const authorization = (server: ServerInfo) => ({ authorization: `Bearer ${server.token}` });
const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

function nodeIdOf(repoRoot: string, absolute: string): NodeId {
  let dir = absolute;
  try {
    if (!statSync(absolute).isDirectory()) dir = dirname(absolute);
  } catch {
    dir = dirname(absolute);
  }
  const id = relative(repoRoot, dir).split(sep).join("/");
  if (id.startsWith("..")) throw new Error(`techtree: ${absolute} is outside the repository ${repoRoot}`);
  return id;
}

const parentOf = (id: NodeId): NodeId => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const label = (id: NodeId) => (id === "" ? "(root)" : id);
const quality = (q: number | null | undefined) => (q == null ? "n/a" : q.toFixed(1));
const progress = (task: Task) => `${task.checklist.filter((c) => c.done).length}/${task.checklist.length}`;

function statusReport(server: ServerInfo, state: ApiState, overview: ApiOverview): string {
  const running = state.tasks.filter((t) => t.state === "running" || t.state === "queued");
  const lines = [
    `techtree: ${server.url}`,
    `root quality: ${quality(state.scores[""]?.quality)}` +
      (state.snapshot ? ` (scored ${state.snapshot.sha.slice(0, 10)} at ${state.snapshot.createdAt})` : ""),
    `running tasks: ${running.length}`,
    ...running.map((t) => `- [${t.state}] ${t.title} in ${label(t.node)} (${t.phase}, ${progress(t)}) id ${t.id}`),
    `needs attention: ${overview.attentionTasks.length + overview.flaggedPrs.length}`,
    ...overview.attentionTasks.map((t) => `- [${t.state}] ${t.title} in ${label(t.node)}${t.question ? `: ${t.question}` : ""}`),
    ...overview.flaggedPrs.map((p) => `- PR #${p.number} ${p.title}: ${p.ci === "fail" ? "CI failing" : p.stuck ? "stuck" : "stale"}`),
  ];
  return lines.join("\n");
}

function findingsReport(id: NodeId, node: ApiNode, limit: number): string {
  const header = `techtree findings for ${label(id)} (quality ${quality(node.score?.quality)}): ${node.findings.length} total`;
  const items = node.findings.slice(0, limit).map((f) => {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    const detail = f.detail.length > 300 ? `${f.detail.slice(0, 300)}…` : f.detail;
    return `- +${f.impact.node.toFixed(2)} [${f.severity}/${f.effort}] ${f.title} —${where} (${f.source}, id ${f.id})\n  ${detail}`;
  });
  const children = node.childCtas.filter((c) => c.kind === "suggestion").length;
  const hint = node.findings.length === 0 && children ? `\nNo own findings; ${children} suggestions below this directory.` : "";
  return [header, ...items].join("\n") + hint;
}

/** Keep the status widget current: one state fetch, then task events, refetching on reconnect. */
async function runWidget(ctx: ExtensionContext, server: ServerInfo, signal: AbortSignal): Promise<void> {
  const tasks = new Map<string, Task>();
  const render = () => {
    const all = [...tasks.values()];
    const running = all.filter((t) => t.state === "running").length;
    const attention = all.filter((t) => t.state === "needs_input" || t.state === "review").length;
    ctx.ui.setWidget(WIDGET, [`techtree: ${running} running · ${attention} need attention · ${server.url}`]);
  };
  while (!signal.aborted) {
    try {
      const state = await api<ApiState>(server, "/api/state", signal);
      tasks.clear();
      for (const t of state.tasks) tasks.set(t.id, t);
      render();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: authorization(server), signal });
      for await (const event of serverEvents(res)) {
        if (event.type !== "task") continue;
        tasks.set(event.task.id, event.task);
        render();
      }
    } catch {
      if (signal.aborted) return;
      ctx.ui.setWidget(WIDGET, [`techtree: disconnected, retrying · ${server.url}`]);
    }
    await sleep(RECONNECT_MS, undefined, { signal }).catch(() => {});
  }
}

async function* serverEvents(res: Response): AsyncGenerator<ServerEvent> {
  if (!res.ok || !res.body) throw new Error(`techtree events: ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = message.split("\n").find((l) => l.startsWith("data: "));
      if (data) yield JSON.parse(data.slice(6)) as ServerEvent;
    }
  }
}
