import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { StartTaskRequest, TaskPhase } from "../types.ts";
import { QUALITY } from "../core/projects.ts";
import { HttpError, type Backend, type ProjectInput, type WorkerReport } from "./backend.ts";

export interface ServerOptions {
  backend: Backend;
  /** Directory holding the built UI (`index.html`, `app.js`). */
  staticDir: string;
  /** 0 (default) picks a random free port. */
  port?: number;
  /** Defaults to 32 random bytes, hex encoded. */
  token?: string;
  heartbeatMs?: number;
  /** Reported unauthenticated by `GET /api/health`. */
  version?: string;
  /** Called for every authorized request (idle tracking). */
  onRequest?: () => void;
}

export interface RunningServer {
  /** Page URL including the token, ready to open in a browser. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** Cookies are not port-scoped, so each server (one per repo) needs its own cookie name. */
const cookieName = (port: number) => `techtree_token_${port}`;
const PHASES: readonly string[] = ["plan", "explore", "edit", "test", "pr"] satisfies TaskPhase[];
const MAX_BODY = 1_000_000;
const DEFAULT_TAIL = 200;
const OK = { ok: true };
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

type Handler = (req: IncomingMessage, url: URL, params: string[]) => Promise<unknown>;
interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pattern: RegExp;
  handle: Handler;
}

/** Start the techtree HTTP/SSE server on 127.0.0.1 (see docs/DESIGN.md, "HTTP API" and "Security"). */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { backend, staticDir, heartbeatMs = 15_000 } = options;
  const token = options.token ?? randomBytes(32).toString("hex");
  const routes = apiRoutes(backend);
  let port = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof URIError ? 400 : 500;
      if (status === 500) console.error("techtree server:", err);
      sendJson(res, status, { error: status === 500 ? "internal error" : (err as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLocalHost(req.headers.host, port)) throw new HttpError(403, "unexpected Host header");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/health" && req.method === "GET") return sendJson(res, 200, { version: options.version ?? "" });
    const queryToken = url.searchParams.get("token");
    if (!authorized(req, queryToken, token, cookieName(port))) throw new HttpError(401, "missing or invalid token");
    options.onRequest?.();
    if (queryToken !== null) res.setHeader("Set-Cookie", `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`);

    if (!url.pathname.startsWith("/api/")) {
      if (queryToken !== null) {
        url.searchParams.delete("token");
        res.writeHead(302, { Location: url.pathname + url.search }).end();
        return;
      }
      return serveStatic(res, staticDir, url.pathname);
    }
    if (url.pathname === "/api/events" && req.method === "GET") return streamEvents(req, res, backend, heartbeatMs);

    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match || route.method !== req.method) continue;
      if (route.method !== "GET") checkMutation(req, port);
      const result = await route.handle(req, url, match.slice(1).map(decodeURIComponent));
      if (typeof result === "string") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(result);
      } else {
        sendJson(res, 200, result);
      }
      return;
    }
    throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function apiRoutes(backend: Backend): Route[] {
  const get = (pattern: RegExp, handle: Handler): Route => ({ method: "GET", pattern, handle });
  const post = (pattern: RegExp, handle: Handler): Route => ({ method: "POST", pattern, handle });
  return [
    get(/^\/api\/projects$/, () => backend.listProjects()),
    post(/^\/api\/projects$/, async (req) => backend.createProject(projectInput(await readJson(req)))),
    { method: "PATCH", pattern: /^\/api\/projects\/([^/]+)$/, handle: async (req, _url, [id]) => backend.updateProject(id, projectInput(await readJson(req))) },
    {
      method: "DELETE",
      pattern: /^\/api\/projects\/([^/]+)$/,
      handle: async (_req, _url, [id]) => {
        await backend.deleteProject(id);
        return OK;
      },
    },
    get(/^\/api\/state$/, (_req, url) => backend.getState(projectParam(url))),
    get(/^\/api\/node$/, (_req, url) => {
      const id = url.searchParams.get("id");
      if (id === null) throw new HttpError(400, "missing id");
      return backend.getNode(id, projectParam(url));
    }),
    get(/^\/api\/overview$/, (_req, url) => backend.getOverview(projectParam(url))),
    get(/^\/api\/tasks\/([^/]+)\/log$/, (_req, url, [id]) => backend.taskLog(id, tailParam(url))),
    get(/^\/api\/tasks\/([^/]+)\/diff$/, (_req, _url, [id]) => backend.taskDiff(id)),
    get(/^\/api\/source$/, (_req, url) => backend.source(url.searchParams.get("path") ?? "", Number(url.searchParams.get("line")) || undefined)),
    get(/^\/api\/models$/, () => backend.models()),
    post(/^\/api\/tasks$/, async (req) => backend.startTask(startTaskRequest(await readJson(req)))),
    post(/^\/api\/tasks\/([^/]+)\/answer$/, async (req, _url, [id]) => {
      const { text } = await readJson(req);
      if (typeof text !== "string") throw new HttpError(400, "text must be a string");
      return backend.answer(id, text);
    }),
    post(/^\/api\/tasks\/([^/]+)\/open-pr$/, (_req, _url, [id]) => backend.openPr(id)),
    post(/^\/api\/tasks\/([^/]+)\/cancel$/, (_req, _url, [id]) => backend.cancel(id)),
    post(/^\/api\/tasks\/([^/]+)\/stage$/, (_req, _url, [id]) => backend.stage(id)),
    post(/^\/api\/tasks\/([^/]+)\/unstage$/, (_req, _url, [id]) => backend.unstage(id)),
    get(/^\/api\/bundles$/, (_req, url) => backend.listBundles(projectParam(url))),
    post(/^\/api\/bundles$/, async (req) => {
      const { project, taskIds, title } = await readJson(req);
      if (!stringList(taskIds) || !taskIds.length) throw new HttpError(400, "taskIds must be a non-empty list of strings");
      if ((project !== undefined && typeof project !== "string") || (title !== undefined && typeof title !== "string"))
        throw new HttpError(400, "project and title must be strings");
      return backend.createBundle({ taskIds, ...(project && { project }), ...(title?.trim() && { title: title.trim() }) });
    }),
    post(/^\/api\/findings\/dismiss$/, async (req) => {
      const { findingIds, reason, project } = await readJson(req);
      if (!stringList(findingIds)) throw new HttpError(400, "findingIds must be a list of strings");
      if ((reason !== undefined && typeof reason !== "string") || (project !== undefined && typeof project !== "string"))
        throw new HttpError(400, "reason and project must be strings");
      await backend.dismiss(findingIds, reason || undefined, project || undefined);
      return OK;
    }),
    post(/^\/api\/findings\/undismiss$/, async (req) => {
      const { findingIds } = await readJson(req);
      if (!stringList(findingIds)) throw new HttpError(400, "findingIds must be a list of strings");
      await backend.undismiss(findingIds);
      return OK;
    }),
    post(/^\/api\/tasks\/([^/]+)\/message$/, async (req, _url, [id]) => {
      const { text } = await readJson(req);
      if (typeof text !== "string") throw new HttpError(400, "text must be a string");
      return backend.message(id, text);
    }),
    get(/^\/api\/tasks\/([^/]+)\/chat$/, (_req, _url, [id]) => backend.chat(id)),
    post(/^\/api\/tasks\/([^/]+)\/open-terminal$/, async (req, _url, [id]) => {
      const { mode } = await readJson(req);
      if (mode !== "shell" && mode !== "agent") throw new HttpError(400, 'mode must be "shell" or "agent"');
      await backend.openTerminal(id, mode);
      return OK;
    }),
    post(/^\/api\/tasks\/([^/]+)\/discard$/, async (_req, _url, [id]) => {
      await backend.discard(id);
      return { ok: true };
    }),
    post(/^\/api\/tasks\/([^/]+)\/report$/, async (req, _url, [id]) =>
      backend.report(id, workerReport(await readJson(req))),
    ),
    post(/^\/api\/prs\/(\d+)\/babysit$/, async (req, _url, [number]) => {
      const { on } = await readJson(req);
      if (typeof on !== "boolean") throw new HttpError(400, "on must be a boolean");
      return backend.setBabysit(Number(number), on);
    }),
    post(/^\/api\/score$/, async (_req, url) => {
      await backend.rescore(projectParam(url));
      return OK;
    }),
    post(/^\/api\/scan$/, async (req, url) => {
      const { node } = await readJson(req);
      if (typeof node !== "string") throw new HttpError(400, "node must be a string");
      await backend.scan(node, projectParam(url));
      return OK;
    }),
  ];
}

function isLocalHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function authorized(req: IncomingMessage, queryToken: string | null, token: string, cookie: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const cookieToken = new RegExp(`(?:^|;\\s*)${cookie}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];
  return [queryToken, bearer, cookieToken].some((candidate) => candidate != null && sameSecret(candidate, token));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function checkMutation(req: IncomingMessage, port: number) {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(403, "mutating requests must send Content-Type: application/json");
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new HttpError(403, "cross-origin request");
  }
}

function projectParam(url: URL): string {
  return url.searchParams.get("project") || QUALITY;
}

function projectInput(body: Record<string, unknown>): ProjectInput {
  const { name, goal } = body;
  if ((name !== undefined && typeof name !== "string") || (goal !== undefined && typeof goal !== "string")) {
    throw new HttpError(400, "name and goal must be strings");
  }
  return { ...(name !== undefined && { name }), ...(goal !== undefined && { goal }) };
}

function tailParam(url: URL): number {
  const raw = url.searchParams.get("tail");
  if (raw === null) return DEFAULT_TAIL;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "tail must be a non-negative integer");
  return Number(raw);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try {
    value = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function startTaskRequest(body: Record<string, unknown>): StartTaskRequest {
  const { node, findingIds, title, prompt, manualReview, model, project } = body;
  const valid =
    typeof node === "string" &&
    Array.isArray(findingIds) &&
    findingIds.every((id) => typeof id === "string") &&
    typeof manualReview === "boolean" &&
    (title === undefined || typeof title === "string") &&
    (prompt === undefined || typeof prompt === "string") &&
    (model === undefined || typeof model === "string") &&
    (project === undefined || typeof project === "string");
  if (!valid) throw new HttpError(400, "body must be a StartTaskRequest");
  return {
    node,
    findingIds,
    manualReview,
    ...(title === undefined ? {} : { title }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(model ? { model } : {}),
    ...(project ? { project } : {}),
  };
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function workerReport(body: Record<string, unknown>): WorkerReport {
  const { plan, phase, done, needs_input, outcome, summary, dismiss, reason } = body;
  const valid =
    (plan === undefined || stringList(plan)) &&
    (phase === undefined || (typeof phase === "string" && PHASES.includes(phase))) &&
    (done === undefined || (Number.isInteger(done) && (done as number) >= 0)) &&
    (needs_input === undefined || typeof needs_input === "string") &&
    (outcome === undefined || outcome === "no_change") &&
    (summary === undefined || typeof summary === "string") &&
    (dismiss === undefined || stringList(dismiss)) &&
    (reason === undefined || typeof reason === "string") &&
    [plan, phase, done, needs_input, outcome, dismiss].some((field) => field !== undefined);
  if (!valid) throw new HttpError(400, "body must be a WorkerReport");
  return body as WorkerReport;
}

function streamEvents(req: IncomingMessage, res: ServerResponse, backend: Backend, heartbeatMs: number) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const unsubscribe = backend.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string) {
  const relative = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  const file = join(staticDir, relative);
  if (!file.startsWith(join(staticDir, sep))) throw new HttpError(404, "not found");
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, "not found");
  }
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}
