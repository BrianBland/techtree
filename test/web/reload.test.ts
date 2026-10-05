import { test } from "node:test";
import assert from "node:assert/strict";

test("the page reloads when the event stream reconnects to a server running another build", async () => {
  let build = "one";
  let reloads = 0;
  let stream: { onopen: () => Promise<void> } | undefined;
  Object.assign(globalThis, {
    fetch: async (path: string) =>
      path === "/api/health" ? Response.json({ version: "0", build }) : new Response("not found", { status: 404 }),
    EventSource: class {
      constructor() {
        stream = this as unknown as typeof stream;
      }
    },
    location: { reload: () => reloads++ },
  });
  const { onReconnect } = await import("../../src/web/api.ts");
  let resyncs = 0;
  onReconnect(() => resyncs++);

  await stream!.onopen();
  await stream!.onopen();
  assert.deepEqual({ reloads, resyncs }, { reloads: 0, resyncs: 1 }, "same build: resync without reloading");

  build = "two";
  await stream!.onopen();
  assert.deepEqual({ reloads, resyncs }, { reloads: 1, resyncs: 1 }, "new build: reload instead of resyncing");
});
