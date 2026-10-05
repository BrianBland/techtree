import { fileURLToPath } from "node:url";
import { createMockBackend } from "./mock.ts";
import { startServer } from "./server.ts";

const backend = createMockBackend();
const server = await startServer({
  backend,
  staticDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
  port: Number(process.env.PORT ?? 0),
});
console.log(`techtree (mock backend): ${server.url}`);
process.on("SIGINT", () => {
  backend.stop();
  void server.close().then(() => process.exit(0));
});
