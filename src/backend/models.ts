import { execFile } from "node:child_process";

const LIST_TIMEOUT_MS = 30_000;

/** `provider/model` for each model `<piCommand> --list-models` prints; [] when pi fails. */
export function listModels(piCommand: string[]): Promise<string[]> {
  const [command, ...prefix] = piCommand;
  return new Promise((resolve) => {
    execFile(command, [...prefix, "--list-models"], { timeout: LIST_TIMEOUT_MS }, (err, stdout) => resolve(err ? [] : parseModelList(stdout)));
  });
}

/** Parse pi's model table: a header row, then rows whose first two columns are provider and model. */
export function parseModelList(text: string): string[] {
  return text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2)
    .map(([provider, model]) => `${provider}/${model}`);
}
