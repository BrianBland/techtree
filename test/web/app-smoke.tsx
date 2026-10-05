import { FakeDocument, type FakeNode } from "./fake-dom.ts";

export interface SmokeDriver {
  root: FakeNode;
  text(): string;
  find(predicate: (n: FakeNode) => boolean): FakeNode[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  close(): void;
}

/**
 * Boot the real UI (`src/web/main.tsx`) in a fake DOM whose `fetch` and `EventSource`
 * talk to a running techtree server.
 */
export async function bootApp(baseUrl: string, token: string): Promise<SmokeDriver> {
  const doc = new FakeDocument();
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const realFetch = globalThis.fetch;
  const abort = new AbortController();
  const authed = (path: string, init: RequestInit = {}) =>
    realFetch(baseUrl + path, {
      ...init,
      signal: abort.signal,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });

  class StreamingEventSource {
    onmessage: ((message: { data: string }) => void) | null = null;
    constructor(path: string) {
      void authed(path).then(async (res) => {
        let buffer = "";
        for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          const messages = buffer.split("\n\n");
          buffer = messages.pop()!;
          for (const m of messages) if (m.startsWith("data: ")) this.onmessage?.({ data: m.slice(6) });
        }
      }).catch(() => {});
    }
  }

  Object.assign(globalThis, {
    document: Object.assign(doc, { getElementById: () => root }),
    fetch: authed,
    EventSource: StreamingEventSource,
  });
  await import("../../src/web/main.tsx");

  const text = () => root.textContent;
  return {
    root,
    text,
    find: (predicate) => root.querySelectorAll(predicate),
    async waitFor(predicate, what) {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}; page text: ${text().slice(0, 400)}`);
    },
    close() {
      abort.abort();
      globalThis.fetch = realFetch;
    },
  };
}
