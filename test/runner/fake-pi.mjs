// Stand-in for `pi --mode rpc`: speaks the JSONL protocol and plays a scenario named by
// `scenario:<name>` in the first prompt. The scenario is kept in a fake session file so a
// respawn with the same --session-dir/--session-id resumes it, as real pi sessions do.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { techtreeReportTool } from "../../src/runner/report-tool.ts";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (process.argv.includes("-p")) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const prompt = input || process.argv.at(-1);
  if (prompt.includes("<conflict-hunks>")) await resolve(prompt);
  else if (prompt.includes("<staged-tasks>")) await group(prompt);
  else console.log("feat: fake combined title");
  process.exit(0);
}

/**
 * Smart grouping: log the argv to `$FAKE_GROUPS.log` and reply with `$FAKE_GROUPS`, where `"title:<t>"` names the staged
 * task titled `<t>` and `"tip:<t>"` the stack tip titled `<t>`. A reply of `HANG` never answers.
 */
async function group(prompt) {
  const file = process.env.FAKE_GROUPS;
  appendFileSync(`${file}.log`, JSON.stringify([...process.argv.slice(2), prompt]) + "\n");
  while (existsSync(`${file}.hold`)) await new Promise((resolve) => setTimeout(resolve, 10));
  let reply = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (reply === "HANG") await new Promise(() => setInterval(() => {}, 1000));
  if (reply.startsWith("{")) {
    const replies = JSON.parse(reply).replies;
    if (Array.isArray(replies)) {
      const attempt = readFileSync(`${file}.log`, "utf8").trim().split("\n").length - 1;
      reply = JSON.stringify(replies[Math.min(attempt, replies.length - 1)]);
    }
  }
  const section = (tag) => JSON.parse(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)[1]);
  const tasks = section("staged-tasks");
  const tips = section("stack-tips");
  console.log(
    reply
      .replace(/"title:([^"]*)"/g, (_, t) => JSON.stringify(tasks.find((x) => x.title === t)?.id ?? `missing ${t}`))
      .replace(/"tip:([^"]*)"/g, (_, t) => JSON.stringify(tips.find((x) => x.title === t)?.id ?? `missing ${t}`)),
  );
}
/**
 * Conflict resolution: log the argv and prompt to `$FAKE_RESOLVE.log`, write the pid to `$FAKE_RESOLVE.pid`, wait while
 * `$FAKE_RESOLVE.hold` exists, then reply as `$FAKE_RESOLVE` says (default `union`: ours lines, then theirs lines).
 */
async function resolve(prompt) {
  const file = process.env.FAKE_RESOLVE;
  appendFileSync(`${file}.log`, JSON.stringify([...process.argv.slice(2), prompt]) + "\n");
  writeFileSync(`${file}.pid`, String(process.pid));
  while (existsSync(`${file}.hold`)) await new Promise((resolve) => setTimeout(resolve, 10));
  const mode = existsSync(file) ? readFileSync(file, "utf8").trim() : "union";
  const hunks = JSON.parse(/<conflict-hunks>\n([\s\S]*?)\n<\/conflict-hunks>/.exec(prompt)[1]);
  const resolved = (pick) => console.log(JSON.stringify({ outcome: "resolved", hunks: hunks.map((h) => ({ id: h.id, lines: pick(h) })), reason: "keeps both additions" }));
  const replies = {
    union: () => resolved((h) => [...h.ours, ...h.theirs]),
    drop: () => resolved((h) => h.ours),
    invent: () => resolved((h) => [...h.ours, ...h.theirs, "invented();"]),
    give_up: () => console.log(JSON.stringify({ outcome: "give_up", reason: "the additions disagree" })),
    invalid: () => console.log("I merged it for you."),
    huge: () => new Promise((resolve) => process.stdout.write("x".repeat(200_000), resolve)),
    fail: () => process.exit(1),
    // A child the wrapper started that would outlive it without process-group cleanup.
    orphan: async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(`${file}.child`, String(child.pid));
      await new Promise(() => {});
    },
  };
  await replies[mode]();
}
if (process.argv.includes("--list-models")) {
  process.stdout.write("provider  model  context  max-out  thinking  images\nfake      alpha  200K     64K      yes       yes\nfake      beta   1M       128K     no        no\n");
  process.exit(0);
}
if (process.argv.includes("--model")) process.stderr.write(`model: ${arg("--model")}\n`);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function timedDialog({ advertised, resolvesAfter, workAfter }, settle) {
  await report({ plan: ["only"] });
  const response = await Promise.race([
    ask({ id: "d1", method: "confirm", title: "Proceed?", timeout: advertised }),
    sleep(resolvesAfter).then(() => ({ confirmed: false })),
  ]);
  await sleep(workAfter);
  say(`confirmed: ${response.confirmed}`);
  commit();
  await report({ done: 0 });
  settle();
}

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
  // Replies to every later message; one containing "finish" completes the checklist.
  async chat(message, settle) {
    if (prompts === 1 && !resumed) return report({ plan: ["reply"] });
    emit({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
    say(`heard: ${message}`);
    if (!message.includes("finish")) return;
    commit();
    await report({ done: 0 });
    settle();
  },
  // Plan task: reports one work item on src/core.
  async plan(_message, settle) {
    await report({ plan: ["read"] });
    await report({ items: [{ node: "src/core", title: "Cache parsed config", detail: "Parse once.", effort: "small" }] });
    await report({ done: 0 });
    settle();
  },
  // Scorer task: proposes a rubric.
  async scorer(_message, settle) {
    await report({ plan: ["draft"] });
    await report({ scorer: { rubric: "allocation-heavy hot paths" } });
    await report({ done: 0 });
    settle();
  },
  async hang() {
    if (prompts === 1) await report({ plan: ["wait"] });
  },
  // pi resolves a timed-out dialog itself; the run then keeps working for a while.
  timeout: (_message, settle) => timedDialog({ advertised: 100, resolvesAfter: 100, workAfter: 300 }, settle),
  // pi's clock resolves the dialog before the runner's timer would, and the agent settles at once.
  expired: (_message, settle) => timedDialog({ advertised: 60_000, resolvesAfter: 20, workAfter: 0 }, settle),
  async stubborn() {
    process.on("SIGTERM", () => {});
    await report({ plan: ["ignore SIGTERM"] });
  },
  async late() {
    process.on("SIGTERM", () => {
      emit({ type: "extension_ui_request", id: "late", method: "confirm", title: "Still there?" });
      setTimeout(() => process.exit(0), 50);
    });
    await report({ plan: ["linger"] });
  },
  async crash() {
    await report({ plan: ["boom"] });
    process.exit(3);
  },
  // Commits and reverts, so the branch has commits but no net diff; a resumed run makes a real change.
  async revert(_message, settle) {
    if (resumed) {
      commit();
      return settle();
    }
    await report({ plan: ["try"] });
    commit();
    execFileSync("git", ["revert", "--no-edit", "HEAD"]);
    await report({ done: 0 });
    say("The finding is a false positive; nothing to change.");
    settle();
  },
  async explain(_message, settle) {
    await report({ plan: ["look"] });
    await report({ outcome: "no_change", summary: "Already correct.", dismiss: ["f1"], reason: "false positive" });
    settle();
  },
  // Breaks the worktree's git link before finishing, so the runner's diff check fails.
  async breakgit(_message, settle) {
    await report({ plan: ["break"] });
    rmSync(".git", { force: true });
    await report({ done: 0 });
    settle();
  },
  // Overwrites README.md with the prompt, so two such tasks conflict.
  async readme(message, settle) {
    await report({ plan: ["rewrite"] });
    writeFileSync("README.md", `${message}\n`);
    execFileSync("git", ["commit", "-qam", "rewrite readme"]);
    await report({ done: 0 });
    settle();
  },
  // Appends `line:<text>` (or `lines:<n>` numbered copies padded to `width:<n>`) to each of `files:<a,b>` (default README.md).
  async append(message, settle) {
    const opt = (name, fallback) => new RegExp(`${name}:(\\S+)`).exec(message)?.[1] ?? fallback;
    const line = opt("line", "added");
    const count = Number(opt("lines", "1"));
    const width = Number(opt("width", "0"));
    const text = Array.from({ length: count }, (_, i) => (count > 1 ? `${line}-${i}` : line).padEnd(width, ".") + "\n").join("");
    await report({ plan: ["append"] });
    for (const path of opt("files", "README.md").split(",")) appendFileSync(path, text);
    execFileSync("git", ["add", "-A"]);
    execFileSync("git", ["commit", "-qm", `append ${line}`]);
    await report({ done: 0 });
    settle();
  },
  // Renames `file:<path>` to `to:<path>`.
  async move(message, settle) {
    await report({ plan: ["move"] });
    renameSync(/file:(\S+)/.exec(message)[1], /to:(\S+)/.exec(message)[1]);
    execFileSync("git", ["add", "-A"]);
    execFileSync("git", ["commit", "-qm", "move"]);
    await report({ done: 0 });
    settle();
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
  if (command.streamingBehavior === "steer") process.stderr.write("streamed as steer\n");
  // The asking run's settle crossing the answer on the wire: it must not count as the answered run settling.
  if (scenario === "ask" && prompts === 1) emit({ type: "agent_settled" });
  if (!scenario) {
    scenario = /scenario:(\w+)/.exec(command.message)?.[1] ?? "hang";
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: arg("--session-id"), scenario }) + "\n");
  }
  if (scenario === "reject")
    return emit({ type: "response", id: command.id, command: "prompt", success: false, error: "No API key found" });
  emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
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
