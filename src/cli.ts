#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { score } from "./core/pipeline.ts";
import { formatReport } from "./core/report.ts";
import { recordFindings, saveSnapshot } from "./core/store.ts";
import { dbCache, openDb, suppressSqliteWarning } from "./db.ts";
import { cacheDir, repoId, repoRootOf } from "./paths.ts";
import { defaultPlugins } from "./plugins/index.ts";
import { llmScanPlugin } from "./plugins/llm-scan.ts";
import { serve, stopServer } from "./backend/serve.ts";

suppressSqliteWarning();

const USAGE = `usage: techtree <command> [repo]

commands:
  score [repo]   score a repository headlessly, save a snapshot and print a summary
  serve [repo] [--port N]
                 run the repository's techtree server in the foreground and print its URL;
                 the UI is read from dist/web on every request, so rebuild and reload
  stop [repo]    stop the repository's techtree server`;

async function scoreCommand(path: string): Promise<number> {
  const repoRoot = repoRootOf(resolve(path));
  const db = openDb(cacheDir(repoId(repoRoot)));
  const started = performance.now();
  const result = await score({
    repoRoot,
    config: loadConfig(repoRoot),
    plugins: [...defaultPlugins, llmScanPlugin],
    cache: dbCache(db),
    log: (msg) => console.error(msg),
  });
  saveSnapshot(db, result);
  recordFindings(db, result.findings, result.createdAt, true);
  console.log(formatReport(result));
  const nodes = Object.keys(result.tree.nodes).length;
  console.error(`scored ${nodes} nodes, ${result.findings.length} findings in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, arg] = argv;
  switch (command) {
    case "score":
      return scoreCommand(arg ?? ".");
    case "serve": {
      const { values, positionals } = parseArgs({ args: argv.slice(1), options: { port: { type: "string" } }, allowPositionals: true });
      const port = values.port === undefined ? 0 : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`invalid --port ${values.port}\n\n${USAGE}`);
        return 1;
      }
      await serve(repoRootOf(resolve(positionals[0] ?? ".")), { port });
      return 0;
    }
    case "stop":
      console.log(await stopServer(repoRootOf(resolve(arg ?? "."))));
      return 0;
    default:
      console.error(USAGE);
      return command ? 1 : 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
