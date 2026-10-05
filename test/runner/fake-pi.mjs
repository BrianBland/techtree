// Stand-in for `pi --mode rpc`: speaks the JSONL protocol and plays a scenario named by
// `scenario:<name>` in the first prompt. The scenario is kept in a fake session file so a
// respawn with the same --session-dir/--session-id resumes it, as real pi sessions do.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { techtreeReportTool } from "../../src/runner/report-tool.ts";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionFile = join(arg("--session-dir"), `${arg("--session-id")}.jsonl`);
const resumed = existsSync(sessionFile);
let scenario = resumed ? JSON.parse(readFileSync(sessionFile, "utf8")).scenario : undefined;
let prompts = 0;
const dialogs = new Map();

const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const report = (payload) => techtreeReportTool.execute("call", payload, undefined, undefined, undefined);
const say = (text) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
// Like real pi, a run with a newer prompt queued continues with it instead of settling.
const settlerFor = (run) => () => run === prompts && emit({ type: "agent_settled" });
const commit = () => {
  writeFileSync(`change-${Date.now()}.txt`, "improved\n");
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["commit", "-qm", "techtree change"]);
};
const ask = (request) =>
  new Promise((resolve) => {
    dialogs.set(request.id, resolve);
    emit({ type: "extension_ui_request", ...request });
  });

const scenarios = {
  async happy(message, settle) {
    if (message.includes("Push branch")) {
      await report({ phase: "pr" });
      writeFileSync(".fake-pr", "42\n");
      return settle();
    }
    await report({ plan: ["first", "second"] });
    await report({ phase: "edit" });
    commit();
    await report({ done: 0 });
    await report({ done: 1 });
    settle();
  },
  async auto(_message, settle) {
    await report({ plan: ["only"], phase: "edit" });
    commit();
    await report({ done: 0, phase: "pr" });
    writeFileSync(".fake-pr", "7\n");
    settle();
  },
  async ask(message, settle) {
    if (prompts === 1) {
      await report({ plan: ["only"] });
      await report({ needs_input: "Which color?" });
      return settle();
    }
    say(`got: ${message}`);
    commit();
    await report({ done: 0 });
    settle();
  },
  async dialog(_message, settle) {
    await report({ plan: ["only"] });
    const response = await ask({ id: "d1", method: "confirm", title: "Proceed?", message: "This rewrites history." });
    say(`confirmed: ${response.confirmed}`);
    commit();
    await report({ done: 0 });
    settle();
  },
  async idle(_message, settle) {
    if (prompts === 1) await report({ plan: ["never done"] });
    say("thinking");
    settle();
  },
  async hang() {
    if (prompts === 1) await report({ plan: ["wait"] });
  },
  async crash() {
    await report({ plan: ["boom"] });
    process.exit(3);
  },
  async resume(message, settle) {
    if (!resumed) return report({ plan: ["survive a restart"] });
    say(`resumed: ${message}`);
    commit();
    await report({ done: 0 });
    settle();
  },
};

function onCommand(command) {
  if (command.type === "extension_ui_response") return dialogs.get(command.id)?.(command);
  if (command.type !== "prompt") return emit({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
  // The asking run's settle crossing the answer on the wire: it must not count as the answered run settling.
  if (scenario === "ask" && prompts === 1) emit({ type: "agent_settled" });
  emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  if (!scenario) {
    scenario = /scenario:(\w+)/.exec(command.message)?.[1] ?? "hang";
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: arg("--session-id"), scenario }) + "\n");
  }
  prompts++;
  emit({ type: "agent_start" });
  scenarios[scenario](command.message, settlerFor(prompts)).catch((err) => {
    process.stderr.write(`fake pi: ${err.stack}\n`);
    process.exit(1);
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) onCommand(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
