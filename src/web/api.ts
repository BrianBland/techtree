import type { ServerEvent } from "../types.ts";

async function parse<T>(res: Response): Promise<T> {
  const isJson = res.headers.get("content-type")?.startsWith("application/json");
  const payload = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(isJson ? (payload as { error: string }).error : String(payload));
  return payload as T;
}

/** GET an `/api` route; auth rides on the cookie. JSON or text out, errors thrown with the server's message. */
export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path));
}

/** A mutating request (`POST`, `PATCH`, `DELETE`) with a JSON body, as the server requires. */
export async function send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown = {}): Promise<T> {
  return parse<T>(await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return send<T>("POST", path, body);
}

type Listener = (event: ServerEvent) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let source: EventSource | undefined;

/** Subscribe to the shared `/api/events` stream; returns the unsubscribe function. */
export function onServerEvent(listener: Listener): () => void {
  source ??= openStream();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Called each time the event stream reconnects. The server does not replay missed events,
 * so subscribers must refetch whatever they display.
 */
export function onReconnect(listener: () => void): () => void {
  source ??= openStream();
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

const serverBuild = () => get<{ build: string }>("/api/health").then((h) => h.build);

/** Reload the page (same URL) when the server came back running another build, so its UI assets load. */
async function reloadOnNewBuild(loaded: Promise<string>): Promise<boolean> {
  const [before, now] = await Promise.all([loaded, serverBuild()]);
  if (!before || before === now) return false;
  location.reload();
  return true;
}

function openStream(): EventSource {
  const stream = new EventSource("/api/events");
  const loadedBuild = serverBuild().catch(() => "");
  let opened = false;
  stream.onopen = async () => {
    if (opened && !(await reloadOnNewBuild(loadedBuild).catch(() => false))) reconnectListeners.forEach((l) => l());
    opened = true;
  };
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data) as ServerEvent;
    listeners.forEach((l) => l(event));
  };
  return stream;
}
