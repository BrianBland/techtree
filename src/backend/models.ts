import { spawn } from "node:child_process";

const KILL_GRACE_MS = 1_000;

/**
 * `provider/model` for each model `<piCommand> --list-models` prints; [] when pi fails or runs past
 * `timeoutMs`, in which case it gets SIGTERM and, if still alive after a grace period, SIGKILL.
 */
export function listModels(piCommand: string[], timeoutMs = 30_000): Promise<string[]> {
  const [command, ...prefix] = piCommand;
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, "--list-models"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const settle = (models: string[]) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve(models);
    };
    child.on("error", () => settle([]));
    child.on("close", (code) => settle(code === 0 && !timedOut ? parseModelList(stdout) : []));
    // A killed pi's own children may keep stdout open, so "close" may never come after a timeout.
    child.on("exit", () => timedOut && settle([]));
  });
}

/** Parse pi's model table: a `provider model …` header row, then rows whose first two columns are provider and model. */
export function parseModelList(text: string): string[] {
  const [header, ...rows] = text.split("\n");
  if (!/^provider\s+model\b/.test(header ?? "")) return [];
  return rows
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2)
    .map(([provider, model]) => `${provider}/${model}`);
}
