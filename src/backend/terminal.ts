import { spawn } from "node:child_process";
import { HttpError } from "../server/backend.ts";

/** Quote each word for a POSIX shell (`'…'`, embedded quotes as `'\''`) and join them with spaces. */
export function shellQuote(words: string[]): string {
  return words.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
}

export interface TerminalRequest {
  /** `config.terminal`; unset uses the platform default. */
  template?: string[];
  platform: NodeJS.Platform;
  cwd: string;
  /** Shell-quoted command line; empty opens a plain shell. */
  command: string;
}

/** Argv that opens a terminal window running `command` in `cwd` (see docs/DESIGN.md "Open in terminal"); undefined when the platform has no default. */
export function terminalArgv({ template, platform, cwd, command }: TerminalRequest): string[] | undefined {
  if (template?.length) {
    const values: Record<string, string> = { "{cwd}": cwd, "{command}": command };
    return template.map((arg) => arg.replace(/\{cwd\}|\{command\}/g, (placeholder) => values[placeholder])).filter((arg) => arg !== "");
  }
  const line = `cd ${shellQuote([cwd])}${command ? ` && ${command}` : ""}`;
  if (platform === "darwin") {
    const appleScriptString = line.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return ["osascript", "-e", `tell application "Terminal" to do script "${appleScriptString}"`, "-e", `tell application "Terminal" to activate`];
  }
  if (platform === "linux") return ["x-terminal-emulator", "-e", "sh", "-c", `${line}; exec "\${SHELL:-/bin/sh}"`];
  return undefined;
}

/** Start `argv` detached from the server; a program that cannot be started is a 501. */
export async function launchDetached(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err) => reject(new HttpError(501, `cannot start terminal ${command}: ${err.message}`)));
  });
  child.unref();
}
