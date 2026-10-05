#!/usr/bin/env node
import { suppressSqliteWarning } from "./db.ts";

suppressSqliteWarning();

const USAGE = `usage: techtree <command> [repo]

commands:
  score [repo]   score a repository headlessly and print a summary`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "score":
      console.error("score: not implemented yet");
      return 1;
    default:
      console.error(USAGE);
      return command ? 1 : 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
