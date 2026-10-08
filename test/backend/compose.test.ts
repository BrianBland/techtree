import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoBackend } from "../../src/backend/backend.ts";
import { parseGroups } from "../../src/backend/compose.ts";
import { mergeConfig } from "../../src/config.ts";
import { dbCache, openDb, suppressSqliteWarning } from "../../src/db.ts";
import type { HttpError } from "../../src/server/backend.ts";
import { runPiPrint } from "../../src/plugins/llm-scan.ts";
import { startServer } from "../../src/server/server.ts";
import type { ApiComposition, Bundle, Task } from "../../src/types.ts";
import { FAKE_PI, fixture, until, withEnv } from "./helpers.ts";

suppressSqliteWarning();

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const status = (err: unknown) => (err as HttpError).status;

interface FakePr {
  number: number;
  state: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  body: string;
}

/** A fake `gh` keeping PRs in a JSON state file: `pr create` (pushed head read with ls-remote), `pr list --head`, `pr view`. */
function fakeGh(bin: string, state: string): void {
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const STATE = ${JSON.stringify(state)};
const s = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { prs: [] };
const a = process.argv.slice(2);
fs.appendFileSync(STATE + ".log", JSON.stringify(a) + "\\n");
const opt = (n) => a[a.indexOf(n) + 1];
const save = () => fs.writeFileSync(STATE, JSON.stringify(s));
const pick = (pr, fields) => Object.fromEntries(fields.split(",").map((f) => [f, pr[f]]));
if (a[0] === "pr" && a[1] === "create") {
  if (s.failCreateEarly) { s.failCreateEarly--; save(); process.exit(1); }
  const head = opt("--head");
  const oid = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + head], { encoding: "utf8" }).split("\\t")[0];
  const number = 100 + s.prs.length;
  s.prs.push({ number, url: "https://github.com/o/r/pull/" + number, state: "OPEN", headRefName: head, baseRefName: opt("--base"), headRefOid: oid, body: opt("--body") });
  save();
  if (s.failCreate) { s.failCreate--; save(); process.exit(1); }
  console.log(s.prs.at(-1).url);
} else if (a[0] === "pr" && a[1] === "list") {
  if (s.failList) process.exit(1);
  console.log(JSON.stringify(s.prs.filter((p) => p.headRefName === opt("--head")).map((p) => pick(p, opt("--json")))));
} else if (a[0] === "pr" && a[1] === "view") {
  if (fs.existsSync(STATE + ".view-hold")) {
    fs.writeFileSync(STATE + ".view-waiting", "");
    while (fs.existsSync(STATE + ".view-hold")) execFileSync("sleep", ["0.05"]);
  }
  const pr = s.prs.find((p) => p.number === Number(a[2]));
  if (!pr) process.exit(1);
  console.log(JSON.stringify(pick(pr, opt("--json"))));
} else process.exit(1);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
}

async function boot(t: TestContext, { titleModel = "fake/cheap" as string | null, conflictChecks = undefined as string[][] | undefined, conflictValidators = undefined as string[] | undefined, files = {} as Record<string, string> } = {}) {
  const { tmp, repo, cache } = fixture(t, files);
  const origin = join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const ghState = join(tmp, "gh-state.json");
  fakeGh(bin, ghState);
  withEnv(t, "PATH", `${bin}:${process.env.PATH}`);
  const groupsFile = join(tmp, "groups.json");
  withEnv(t, "FAKE_GROUPS", groupsFile);
  const resolveFile = join(tmp, "resolve");
  withEnv(t, "FAKE_RESOLVE", resolveFile);
  mkdirSync(cache, { recursive: true });
  const config = mergeConfig({ minLoc: 1, worktreeTemplate: `${tmp}/wt/{task}`, piCommand: [process.execPath, FAKE_PI], ...(titleModel && { titleModel }), ...(conflictChecks && { conflictChecks }), ...(conflictValidators && { conflictValidators }) });
  const start = (debounceMs: number) => new RepoBackend({ db: openDb(cache), repoRoot: repo, cacheDir: cache, config, log: () => {}, groupDebounceMs: debounceMs });
  const backend = start(50);
  const server = await startServer({ backend, staticDir: tmp, token: "tok" });
  backend.attach({ url: `http://127.0.0.1:${server.port}`, token: "tok" });
  t.after(async () => {
    await backend.close();
    await server.close();
  });
  await backend.idle();

  const reviewed = async (title: string, scenario = "happy"): Promise<Task> => {
    const task = await backend.startTask({ node: "", findingIds: [], title, prompt: `${title} scenario:${scenario}`, manualReview: true });
    return until(async () => (await backend.getState()).tasks.find((x) => x.id === task.id && x.state === "review"), `${task.id} in review`);
  };
  /** Reply to the next grouping runs; task and tip references are titles (see fake-pi.mjs). */
  const replyWith = (groups: { tasks: string[]; parent?: string; rationale?: string }[]) =>
    writeFileSync(groupsFile, JSON.stringify({ groups: groups.map((g) => ({ tasks: g.tasks.map((x) => `title:${x}`), parent: g.parent ? `tip:${g.parent}` : null, rationale: g.rationale ?? "related" })) }));
  const settled = (b = backend) => until(async () => {
    const c = await b.getComposition();
    return c.status !== "planning" && c.status !== "queued" ? c : undefined;
  }, "grouping to settle");
  const plan = async (): Promise<ApiComposition> => {
    await backend.planComposition();
    return settled();
  };
  const publish = (c: ApiComposition) => backend.publishComposition({ proposalId: c.proposal!.id, fingerprint: c.proposal!.fingerprint });
  const groupCalls = (): string[][] => (existsSync(`${groupsFile}.log`) ? readFileSync(`${groupsFile}.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const gh = () => (existsSync(ghState) ? JSON.parse(readFileSync(ghState, "utf8")) : { prs: [] }) as { prs: FakePr[]; failCreate?: number; failCreateEarly?: number };
  const setGh = (next: object) => writeFileSync(ghState, JSON.stringify({ ...gh(), ...next }));
  const ghCreates = () => (existsSync(`${ghState}.log`) ? readFileSync(`${ghState}.log`, "utf8") : "").split("\n").filter((l) => l.startsWith('["pr","create"')).length;
  const task = async (id: string) => (await backend.getState()).tasks.find((x) => x.id === id)!;
  const bundleOf = async (taskId: string) => (await backend.listBundles()).find((b) => b.taskIds.includes(taskId))!;
  const resolveCalls = (): string[][] => (existsSync(`${resolveFile}.log`) ? readFileSync(`${resolveFile}.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const bundleWorktree = () => { const name = existsSync(join(tmp, "wt")) && readdirSync(join(tmp, "wt")).find((n) => n.startsWith("bundle-")); return name ? join(tmp, "wt", name) : undefined; };
  return { resolveFile, resolveCalls, bundleWorktree, ghState, backend, repo, origin, cache, tmp, start, reviewed, replyWith, settled, plan, publish, groupCalls, gh, setGh, ghCreates, task, bundleOf };
}

type Ctx = Awaited<ReturnType<typeof boot>>;

/** Stage `titles` (reviewed with `scenario`) with automatic grouping off. */
async function staged(ctx: Ctx, titles: string[], scenario = "happy"): Promise<Task[]> {
  await ctx.backend.setAutoComposition(false);
  const tasks: Task[] = [];
  for (const title of titles) tasks.push(await ctx.reviewed(title, scenario));
  for (const t of tasks) await ctx.backend.stage(t.id);
  return tasks;
}

test("grouping output must be one JSON object partitioning the staged tasks, with eligible parents used once", () => {
  const ok = (groups: unknown) => JSON.stringify({ groups });
  assert.deepEqual(parseGroups("```json\n" + ok([{ tasks: ["a", "b"], parent: null, rationale: "retry" }, { tasks: ["c"], parent: "t1", rationale: "colors" }]) + "\n```", ["a", "b", "c"], ["t1"]), [
    { taskIds: ["a", "b"], rationale: "retry" },
    { taskIds: ["c"], parent: "t1", rationale: "colors" },
  ]);
  const invalid: [string, string[], string[]][] = [
    [ok([{ tasks: ["a"], parent: null, rationale: "" }]), ["a", "b"], []], // b missing
    [ok([{ tasks: ["a", "a"], parent: null, rationale: "" }]), ["a"], []], // duplicate
    [ok([{ tasks: ["a"], parent: null, rationale: "" }, { tasks: ["a"], parent: null, rationale: "" }]), ["a"], []],
    [ok([{ tasks: ["a", "x"], parent: null, rationale: "" }]), ["a"], []], // unknown id
    [ok([{ tasks: [], parent: null, rationale: "" }, { tasks: ["a"], parent: null, rationale: "" }]), ["a"], []], // empty group
    [ok([{ tasks: ["a"], parent: "t2", rationale: "" }]), ["a"], ["t1"]], // not an eligible tip
    [ok([{ tasks: ["a"], parent: "t1", rationale: "" }, { tasks: ["b"], parent: "t1", rationale: "" }]), ["a", "b"], ["t1"]], // tip twice
    [ok([{ tasks: ["a"], parent: null, rationale: "x".repeat(301) }]), ["a"], []],
    [ok([{ tasks: ["a"], parent: null }]), ["a"], []], // no rationale
    [`Here you go: ${ok([{ tasks: ["a"], parent: null, rationale: "" }])}`, ["a"], []], // prose around the JSON
    [JSON.stringify({ groups: "a" }), ["a"], []],
    ["", ["a"], []],
  ];
  for (const [output, ids, tips] of invalid) assert.equal(typeof parseGroups(output, ids, tips), "string", output);
});

test("print runner accepts large prompts over stdin and rejects excessive output", async () => {
  const input = "x".repeat(6000);
  const reader = "let s=''; for await (const c of process.stdin) s+=c; console.log(s.length);";
  assert.equal((await runPiPrint([process.execPath, "--input-type=module", "-e", reader, "--"], process.cwd(), [], 5000, undefined, { input, maxOutputBytes: 100 })).trim(), "6000");
  await assert.rejects(
    runPiPrint([process.execPath, "-e", "console.log('x'.repeat(6000))", "--"], process.cwd(), [], 5000, undefined, { maxOutputBytes: 100 }),
    /output exceeded/,
  );
});

test("automatic grouping coalesces staging into one cheap no-tools run over the changes and never publishes", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, origin, replyWith, groupCalls, settled, gh } = ctx;
  assert.equal((await backend.getComposition()).auto, true, "on by default");
  const a = await ctx.reviewed("Retry validation");
  const b = await ctx.reviewed("Retry tests");
  const c = await ctx.reviewed("Tree colors");
  replyWith([{ tasks: ["Retry validation", "Retry tests"], rationale: "retry" }, { tasks: ["Tree colors"] }]);
  for (const x of [a, b, c]) await backend.stage(x.id);

  const composition = await until(async () => {
    const comp = await settled();
    return comp.proposal && !comp.proposal.stale ? comp : undefined;
  }, "a fresh proposal");
  assert.deepEqual(composition.proposal!.groups.map((g) => g.taskIds), [[a.id, b.id], [c.id]]);
  assert.equal(composition.proposal!.groups[0].rationale, "retry");
  assert.equal(composition.proposal!.model, "fake/cheap");
  const calls = groupCalls();
  assert.equal(calls.length, 1, "three stagings within the debounce make one run");
  assert.ok(calls[0].includes("--no-tools"));
  assert.equal(calls[0][calls[0].indexOf("--model") + 1], "fake/cheap");
  const prompt = calls[0].at(-1)!;
  assert.ok(prompt.includes(a.id) && prompt.includes("change-") && /data/i.test(prompt), "ids and changed files as data");

  assert.deepEqual(gh().prs, []);
  assert.doesNotMatch(git(origin, "branch", "--list"), /techtree/);
  assert.deepEqual((await backend.getState()).tasks.map((x) => x.state), ["staged", "staged", "staged"]);
});

test("with automatic grouping off nothing plans until Smart group; an empty pool needs no model call", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, replyWith, groupCalls, plan } = ctx;
  const [a] = await staged(ctx, ["Retry validation"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(groupCalls().length, 0);
  assert.equal((await backend.getComposition()).proposal, undefined);

  replyWith([{ tasks: ["Retry validation"] }]);
  const planned = await plan();
  assert.deepEqual(planned.proposal?.groups.map((g) => g.taskIds), [[a.id]], planned.error);
  assert.equal(groupCalls().length, 1);

  await backend.unstage(a.id);
  assert.equal((await backend.getComposition()).proposal!.stale, true, "an unstaged task invalidates the proposal");
  const empty = await plan();
  assert.equal(empty.proposal, undefined);
  assert.equal(groupCalls().length, 1);
});

test("automatic grouping needs a cheap model; Smart group then runs on pi's default and says so", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t, { titleModel: null });
  const { backend, replyWith, groupCalls, plan } = ctx;
  const comp = await backend.getComposition();
  assert.equal(comp.model, null);
  const a = await ctx.reviewed("Retry validation");
  await backend.stage(a.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(groupCalls().length, 0, "the expensive default model is never called automatically");
  replyWith([{ tasks: ["Retry validation"] }]);
  assert.equal((await plan()).proposal!.model, "pi default");
  assert.ok(!groupCalls()[0].includes("--model"));
});

test("grouping corrects a staged task mistaken for a parent once, without publishing", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Retry validation", "Retry tests"]);
  const group = { tasks: [a.id, b.id], parent: null as string | null, rationale: "retry" };
  writeFileSync(join(ctx.tmp, "groups.json"), JSON.stringify({ replies: [
    { groups: [{ ...group, parent: a.id }] },
    { groups: [group] },
  ] }));
  const planned = await ctx.plan();
  assert.equal(planned.error, undefined);
  assert.deepEqual(planned.proposal!.groups, [{ taskIds: [a.id, b.id], rationale: "retry" }]);
  const calls = ctx.groupCalls();
  assert.equal(calls.length, 2);
  assert.match(calls[0].at(-1)!, /Allowed parent IDs: \[\]/);
  assert.match(calls[0].at(-1)!, /never a staged task/i);
  assert.ok(calls[1].at(-1)!.includes(`parent ${a.id} is not an open stack tip`), "correction includes the precise validation error");
  assert.deepEqual(ctx.gh().prs, []);
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"]);
});

test("grouping still rejects invalid parents after one correction instead of dropping them", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  writeFileSync(join(ctx.tmp, "groups.json"), JSON.stringify({ groups: [{ tasks: [a.id], parent: a.id, rationale: "retry" }] }));
  const failed = await ctx.plan();
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /not an open stack tip/);
  assert.equal(failed.proposal, undefined);
  assert.equal(ctx.groupCalls().length, 2, "invalid output never causes an unbounded retry loop");
  assert.deepEqual(ctx.gh().prs, []);
  assert.equal((await ctx.task(a.id)).state, "staged");
});

test("invalid grouping output fails visibly and leaves every task staged", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, replyWith, plan } = ctx;
  await staged(ctx, ["Retry validation", "Retry tests"]);
  replyWith([{ tasks: ["Retry validation"] }]);
  const failed = await plan();
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Retry tests|missing|exactly once/i);
  assert.equal(failed.proposal, undefined);
  assert.deepEqual((await backend.getState()).tasks.map((x) => x.state), ["staged", "staged"]);
});

test("publishing [A, B], [C] stacks B on A and C on main without touching task branches; D later appends to the B tip", { timeout: 90_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, origin, repo, replyWith, plan, publish, gh, task, bundleOf } = ctx;
  const [a, b, c] = await staged(ctx, ["Retry validation", "Retry tests", "Tree colors"]);
  const heads = [a, b, c].map((x) => git(repo, "rev-parse", x.branch!));
  replyWith([{ tasks: ["Retry validation", "Retry tests"] }, { tasks: ["Tree colors"] }]);
  const result = await publish(await plan());
  assert.equal(result.lastResult?.error, undefined);
  assert.equal(result.lastResult?.bundleIds.length, 3);

  const [bA, bB, bC] = await Promise.all([a, b, c].map((x) => bundleOf(x.id)));
  assert.deepEqual([bA.base, bA.parent, bA.stack], ["main", undefined, bA.id]);
  assert.deepEqual([bB.base, bB.parent, bB.stack], [bA.branch, bA.id, bA.id]);
  assert.deepEqual([bC.base, bC.parent, bC.stack], ["main", undefined, bC.id]);
  const prOf = (bundle: Bundle) => gh().prs.find((p) => p.number === bundle.pr)!;
  assert.equal(prOf(bB).baseRefName, bA.branch);
  assert.equal(prOf(bA).baseRefName, "main");
  assert.match(prOf(bB).body, new RegExp(`Stacked on #${bA.pr}`));
  git(origin, "merge-base", "--is-ancestor", bA.head!, bB.head!);
  assert.equal(git(origin, "rev-list", "--count", `main..${bB.branch}`), "2");
  assert.equal(git(origin, "rev-list", "--count", `main..${bC.branch}`), "1");
  assert.deepEqual([a, b, c].map((x) => git(repo, "rev-parse", x.branch!)), heads, "task branches untouched");
  for (const [x, bundle] of [[a, bA], [b, bB], [c, bC]] as const) {
    const now = await task(x.id);
    assert.deepEqual([now.state, now.bundle, now.pr], ["pr_open", bundle.id, bundle.pr]);
  }
  assert.deepEqual((await backend.getComposition()).stacks.map((s) => s.id), [bA.id, bB.id, bC.id]);

  const [d] = await staged(ctx, ["Retry telemetry"]);
  replyWith([{ tasks: ["Retry telemetry"], parent: "Retry tests" }]);
  const proposal = await plan();
  assert.deepEqual(proposal.proposal!.groups, [{ taskIds: [d.id], parent: bB.id, rationale: "related" }]);
  assert.equal((await publish(proposal)).lastResult?.error, undefined);
  const bD = await bundleOf(d.id);
  assert.deepEqual([bD.base, bD.parent, bD.stack], [bB.branch, bB.id, bA.id]);
  git(origin, "merge-base", "--is-ancestor", bB.head!, bD.head!);
  assert.equal(git(origin, "rev-parse", bB.branch), bB.head, "the parent branch is not rewritten");
});

test("a stale or foreign proposal is refused: changed head, unstaged task, other id or fingerprint", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, replyWith, plan, publish, gh } = ctx;
  const [a, b] = await staged(ctx, ["Retry validation", "Retry tests"]);
  replyWith([{ tasks: ["Retry validation", "Retry tests"] }]);
  const comp = await plan();
  await assert.rejects(backend.publishComposition({ proposalId: "other", fingerprint: comp.proposal!.fingerprint }), (e) => status(e) === 409);
  await assert.rejects(backend.publishComposition({ proposalId: comp.proposal!.id, fingerprint: "other" }), (e) => status(e) === 409);

  writeFileSync(join(a.worktree!, "edit.txt"), "late edit\n");
  git(a.worktree!, "add", "-A");
  git(a.worktree!, "commit", "-qm", "late edit");
  assert.equal((await backend.getComposition()).proposal!.stale, true);
  await assert.rejects(publish(comp), (e) => status(e) === 409 && /stale/.test((e as Error).message));

  const fresh = await plan();
  await backend.unstage(b.id);
  await assert.rejects(publish(fresh), (e) => status(e) === 409);
  assert.deepEqual(gh().prs, []);
});

test("a conflict unstages only the offending task, preserves its source and opened parent, and regroups without publishing", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, repo, replyWith, plan, publish, task, bundleOf } = ctx;
  const [a, b] = await staged(ctx, ["Readme A", "Readme B"], "readme");
  const [c] = await staged(ctx, ["Tree colors"]);
  replyWith([{ tasks: ["Readme A", "Readme B"] }, { tasks: ["Tree colors"] }]);
  const proposal = await plan();
  const sourceHead = git(repo, "rev-parse", b.branch!);
  replyWith([{ tasks: ["Tree colors"] }]);
  const result = await publish(proposal);
  const bA = await bundleOf(a.id);
  assert.deepEqual(result.lastResult?.bundleIds, [bA.id]);
  assert.match(result.lastResult!.error!, new RegExp(b.id));
  assert.equal(result.proposal, undefined, "retrying needs a new confirmation");
  assert.deepEqual([(await task(a.id)).state, (await task(b.id)).state, (await task(c.id)).state], ["pr_open", "review", "staged"]);
  const unstaged = await task(b.id);
  assert.equal(unstaged.stagedAt, undefined);
  assert.match(unstaged.error!, /automatically unstaged/i);
  assert.match(unstaged.error!, /README.md/);
  assert.equal(git(repo, "rev-parse", b.branch!), sourceHead);
  assert.ok(existsSync(b.worktree!));
  const regrouped = await ctx.settled();
  assert.equal(regrouped.auto, false, "one-shot recovery does not change the setting");
  assert.deepEqual(regrouped.proposal?.groups.map((g) => g.taskIds), [[c.id]], regrouped.error);
  assert.equal(regrouped.proposal!.stale, false);
  assert.equal(ctx.ghCreates(), 1, "recovery does not publish the new proposal");
  const saved = openDb(ctx.cache);
  assert.match(JSON.parse((saved.prepare("SELECT data FROM tasks WHERE id = ?").get(b.id) as { data: string }).data).error, /automatically unstaged/i);
  saved.close();
  await backend.stage(b.id);
  assert.equal((await task(b.id)).error, undefined, "restaging clears the recovery notice");
  assert.equal(git(repo, "branch", "--list", "techtree/bundle-*").replace(/^[*+ ]+/, ""), bA.branch, "the failed composition branch is removed");
});

test("a root conflict unstages its task and clears an empty pool without a model call", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Obsolete readme"], "readme");
  ctx.replyWith([{ tasks: ["Obsolete readme"] }]);
  const proposal = await ctx.plan();
  writeFileSync(join(ctx.repo, "README.md"), "upstream changed this file\n");
  git(ctx.repo, "add", "README.md");
  git(ctx.repo, "commit", "-qm", "Upstream change");
  git(ctx.repo, "push", "-q", "origin", "main");
  // The remote moved after grouping; preserve the local fingerprint so replay sees the actual conflict.
  git(ctx.repo, "reset", "--hard", "HEAD^");
  const result = await ctx.publish(proposal);
  assert.deepEqual(result.lastResult?.bundleIds, []);
  assert.match(result.lastResult!.error!, /automatically unstaged/i);
  assert.equal((await ctx.task(a.id)).state, "review");
  const recovered = await ctx.settled();
  assert.equal(recovered.proposal, undefined);
  assert.equal(ctx.groupCalls().length, 1);
  assert.equal(ctx.ghCreates(), 0);
});

test("a non-conflict cherry-pick failure leaves the task staged and does not regroup", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: ["Retry validation"] }]);
  const proposal = await ctx.plan();
  const realGit = git(ctx.repo, "--exec-path");
  writeFileSync(join(ctx.tmp, "bin", "git"), `#!/bin/sh\nif [ "$1" = "cherry-pick" ] && [ "$2" != "--abort" ]; then echo 'injected git failure' >&2; exit 1; fi\nexec ${JSON.stringify(join(realGit, "git"))} "$@"\n`);
  chmodSync(join(ctx.tmp, "bin", "git"), 0o755);
  const result = await ctx.publish(proposal);
  assert.match(result.lastResult!.error!, /injected git failure/);
  assert.doesNotMatch(result.lastResult!.error!, /conflict|automatically unstaged/i);
  assert.equal((await ctx.task(a.id)).state, "staged");
  assert.equal(ctx.groupCalls().length, 1);
  assert.equal(ctx.ghCreates(), 0);
});

test("manual combined publication also regroups the remaining pool after automatically unstaging its conflicting task", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Readme A", "Readme B"], "readme");
  const [c] = await staged(ctx, ["Tree colors"]);
  ctx.replyWith([{ tasks: ["Readme A", "Readme B"] }, { tasks: ["Tree colors"] }]);
  await ctx.plan();
  ctx.replyWith([{ tasks: ["Readme A"] }, { tasks: ["Tree colors"] }]);
  await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id, b.id] }), (err) => status(err) === 409 && /automatically unstaged/.test((err as Error).message));
  const regrouped = await ctx.settled();
  assert.equal(regrouped.auto, false);
  assert.deepEqual(regrouped.proposal?.groups.map((group) => group.taskIds), [[a.id], [c.id]], regrouped.error);
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state, (await ctx.task(c.id)).state], ["staged", "review", "staged"]);
  assert.equal(ctx.groupCalls().length, 2);
  assert.equal(ctx.ghCreates(), 0);
});

test("failed conflict recovery persistence restores staged state and releases publication status", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Readme A", "Readme B"], "readme");
  ctx.replyWith([{ tasks: ["Readme A", "Readme B"] }]);
  const proposal = await ctx.plan();
  const before = { ...(await ctx.task(b.id)) };
  const db = openDb(ctx.cache);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_unstage BEFORE UPDATE ON tasks WHEN OLD.state = 'staged' AND NEW.state = 'review' BEGIN SELECT RAISE(ABORT, 'injected unstage persistence failure'); END");
  const result = await ctx.publish(proposal);
  assert.equal(result.status, "idle");
  assert.match(result.lastResult!.error!, /automatic unstaging failed.*injected unstage persistence failure/);
  assert.deepEqual(await ctx.task(b.id), before);
  assert.equal((db.prepare("SELECT state FROM tasks WHERE id = ?").get(b.id) as { state: string }).state, "staged");
  assert.equal((await ctx.task(a.id)).state, "pr_open");
  assert.equal(ctx.groupCalls().length, 1, "no regroup claims to have excluded an unpersisted task");
  db.exec("DROP TRIGGER fail_unstage");
  await ctx.backend.unstage(b.id);
  assert.equal((await ctx.task(b.id)).state, "review");
});

test("manual conflict recovery persistence failure remains a diagnostic 409 and leaves tasks staged", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Readme A", "Readme B"], "readme");
  const before = { ...(await ctx.task(b.id)) };
  const db = openDb(ctx.cache);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_unstage BEFORE UPDATE ON tasks WHEN OLD.state = 'staged' AND NEW.state = 'review' BEGIN SELECT RAISE(ABORT, 'injected unstage persistence failure'); END");
  await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id, b.id] }), (err) => {
    assert.equal(status(err), 409);
    assert.match((err as Error).message, new RegExp(b.id));
    assert.match((err as Error).message, /README.md/);
    assert.match((err as Error).message, /automatic unstaging failed.*injected unstage persistence failure/);
    return true;
  });
  assert.deepEqual(await ctx.task(b.id), before);
  assert.equal((await ctx.task(a.id)).state, "staged");
  assert.equal(ctx.ghCreates(), 0);
  assert.equal(ctx.groupCalls().length, 0);
});

test("an ambiguous PR create is adopted from its owned branch on retry, without a duplicate PR", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { replyWith, plan, publish, gh, setGh, ghCreates, task, bundleOf } = ctx;
  const [a] = await staged(ctx, ["Retry validation"]);
  replyWith([{ tasks: ["Retry validation"] }]);
  setGh({ failCreate: 1 });
  const failed = await publish(await plan());
  assert.ok(failed.lastResult?.error);
  assert.equal((await task(a.id)).state, "staged");
  assert.equal(gh().prs.length, 1, "the PR was created even though gh failed");

  const retried = await publish(await plan());
  assert.equal(retried.lastResult?.error, undefined);
  assert.equal(ghCreates(), 1, "no second gh pr create");
  assert.equal(gh().prs.length, 1);
  const bundle = await bundleOf(a.id);
  assert.equal(bundle.pr, gh().prs[0].number);
  assert.equal(bundle.branch, gh().prs[0].headRefName);
  assert.equal((await task(a.id)).state, "pr_open");
});

test("a branch pushed before a failed PR create gets its PR on retry, from the same branch", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { origin, replyWith, plan, publish, gh, setGh, bundleOf } = ctx;
  const [a] = await staged(ctx, ["Retry validation"]);
  replyWith([{ tasks: ["Retry validation"] }]);
  setGh({ failCreateEarly: 1 });
  assert.ok((await publish(await plan())).lastResult?.error);
  const pushed = git(origin, "branch", "--list", "techtree/bundle-*").trim();
  assert.ok(pushed, "the pushed branch is kept");
  assert.equal((await publish(await plan())).lastResult?.error, undefined);
  assert.equal(gh().prs.length, 1);
  assert.equal((await bundleOf(a.id)).branch, pushed);
});

test("appending to a parent whose PR changed or closed fails before anything is pushed", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { replyWith, plan, publish, gh, setGh, task, bundleOf } = ctx;
  const [a] = await staged(ctx, ["Retry validation"]);
  replyWith([{ tasks: ["Retry validation"] }]);
  await publish(await plan());
  const parent = gh().prs[0];

  const [d] = await staged(ctx, ["Retry telemetry"]);
  replyWith([{ tasks: ["Retry telemetry"], parent: "Retry validation" }]);
  for (const drift of [{ headRefOid: "0".repeat(40) }, { state: "CLOSED" }, { baseRefName: "other" }]) {
    setGh({ prs: [{ ...parent, ...drift }] });
    const result = await publish(await plan());
    assert.match(result.lastResult?.error ?? "", /parent|#100/i, JSON.stringify(drift));
    assert.equal((await task(d.id)).state, "staged");
    assert.equal(gh().prs.length, 1);
  }
  setGh({ prs: [parent] });
  assert.equal((await publish(await plan())).lastResult?.error, undefined);
  assert.equal((await bundleOf(d.id)).parent, (await bundleOf(a.id)).id);
});

test("manual and smart publications reserve their tasks against each other, unstage and discard", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, replyWith, plan, publish, gh } = ctx;
  const [a, b] = await staged(ctx, ["Retry validation", "Tree colors"]);
  replyWith([{ tasks: ["Retry validation"] }, { tasks: ["Tree colors"] }]);
  const comp = await plan();

  const manual = backend.createBundle({ taskIds: [a.id] });
  await assert.rejects(publish(comp), (e) => status(e) === 409);
  await assert.rejects(backend.unstage(a.id), (e) => status(e) === 409);
  await assert.rejects(backend.discard(a.id), (e) => status(e) === 409);
  await manual;

  replyWith([{ tasks: ["Tree colors"] }]);
  const next = await plan();
  const smart = publish(next);
  await assert.rejects(backend.createBundle({ taskIds: [b.id] }), (e) => status(e) === 409);
  await assert.rejects(backend.unstage(b.id), (e) => status(e) === 409);
  assert.equal((await smart).lastResult?.error, undefined);
  assert.equal(gh().prs.length, 2, "each task published once");
});

test("a stacked child merged into its parent's branch settles only once the parent merges", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, cache, replyWith, plan, publish, setGh, gh, task, bundleOf } = ctx;
  const [a, b] = await staged(ctx, ["Retry validation", "Retry tests"]);
  replyWith([{ tasks: ["Retry validation", "Retry tests"] }]);
  await publish(await plan());
  const [bA, bB] = [await bundleOf(a.id), await bundleOf(b.id)];
  const retire = (n: number) => dbCache(openDb(cache)).set("pr-retired", String(n), true);
  const mark = (n: number, state: string) => setGh({ prs: gh().prs.map((p) => (p.number === n ? { ...p, state } : p)) });
  const [c] = await staged(ctx, ["Retry telemetry"]);
  replyWith([{ tasks: [c.title], parent: b.title }]);
  await plan();
  const compositions: ApiComposition[] = [];
  t.after(backend.subscribe((event) => { if (event.type === "composition") compositions.push(event.composition); }));

  mark(bB.pr, "MERGED");
  retire(bB.pr);
  await backend.reconcileBundles();
  assert.equal((await task(b.id)).state, "pr_open", "merged into the parent branch is not done yet");
  assert.ok(compositions.some((c) => c.proposal?.stale && !c.stacks.some((b) => b.id === bB.id)), "retirement refreshes the stale proposal while task settlement waits");

  mark(bA.pr, "MERGED");
  retire(bA.pr);
  await backend.reconcileBundles();
  assert.deepEqual([(await task(a.id)).state, (await task(b.id)).state], ["done", "done"]);
});

test("planning pending at shutdown runs on the next start; close aborts a running plan", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const { backend, replyWith, groupCalls, settled, start, tmp } = ctx;
  const a = await ctx.reviewed("Retry validation");
  writeFileSync(join(tmp, "groups.json"), "HANG");
  await backend.stage(a.id);
  await until(() => groupCalls().length === 1, "a running plan");
  await backend.close();
  assert.equal((await backend.getComposition()).proposal, undefined);

  replyWith([{ tasks: ["Retry validation"] }]);
  const next = start(50);
  t.after(() => next.close());
  next.attach({ url: "http://127.0.0.1:1", token: "tok" });
  const comp = await until(async () => {
    const c = await settled(next);
    return c.proposal && !c.proposal.stale ? c : undefined;
  }, "replanned after restart");
  assert.deepEqual(comp.proposal!.groups.map((g) => g.taskIds), [[a.id]]);
  assert.equal((await next.getState()).tasks[0].state, "staged", "a restart never publishes");
});

test("recovery never publishes an intent for a different confirmed task head", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: [a.title] }]);
  ctx.setGh({ failCreateEarly: 1 });
  assert.ok((await ctx.publish(await ctx.plan())).lastResult?.error);
  writeFileSync(join(a.worktree!, "late-fix.txt"), "late fix\n");
  git(a.worktree!, "add", "-A");
  git(a.worktree!, "commit", "-qm", "late fix");
  const result = await ctx.publish(await ctx.plan());
  assert.match(result.lastResult?.error ?? "", /intent|publication.*changed/i);
  assert.equal(ctx.gh().prs.length, 0);
  assert.equal((await ctx.task(a.id)).state, "staged");
  assert.equal((await ctx.publish(await ctx.plan())).lastResult?.error, undefined);
  const bundle = await ctx.bundleOf(a.id);
  assert.equal(bundle.sourceHead, git(a.worktree!, "rev-parse", "HEAD"));
  assert.equal(git(ctx.origin, "show", `${bundle.branch}:late-fix.txt`), "late fix");
});

test("recovery never creates against an intent's old parent after regrouping as a root", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: [a.title] }]);
  await ctx.publish(await ctx.plan());
  const [b] = await staged(ctx, ["Retry tests"]);
  ctx.replyWith([{ tasks: [b.title], parent: a.title }]);
  ctx.setGh({ failCreateEarly: 1 });
  assert.ok((await ctx.publish(await ctx.plan())).lastResult?.error);
  ctx.setGh({ prs: ctx.gh().prs.map((p) => ({ ...p, state: "CLOSED" })) });
  ctx.replyWith([{ tasks: [b.title] }]);
  const result = await ctx.publish(await ctx.plan());
  assert.match(result.lastResult?.error ?? "", /intent|publication.*changed/i);
  assert.equal(ctx.gh().prs.length, 1);
  assert.equal((await ctx.task(b.id)).state, "staged");
  assert.equal((await ctx.publish(await ctx.plan())).lastResult?.error, undefined);
  assert.equal((await ctx.bundleOf(b.id)).base, "main");
});

test("manual publication refuses unresolved smart intents instead of duplicating their PRs", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: [a.title] }]);
  ctx.setGh({ failCreate: 1 });
  assert.ok((await ctx.publish(await ctx.plan())).lastResult?.error);
  await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id] }), (e) => status(e) === 409);
  assert.equal(ctx.gh().prs.length, 1);
  assert.equal((await ctx.publish(await ctx.plan())).lastResult?.error, undefined);
  assert.equal(ctx.ghCreates(), 1);
});

test("a replay whose commits cancel out is refused before push or PR creation", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  git(a.worktree!, "revert", "--no-edit", "HEAD");
  ctx.replyWith([{ tasks: [a.title] }]);
  const result = await ctx.publish(await ctx.plan());
  assert.match(result.lastResult?.error ?? "", /changes nothing/);
  assert.equal(ctx.ghCreates(), 0);
  assert.equal(git(ctx.origin, "branch", "--list", "techtree/bundle-*"), "");
  assert.equal((await ctx.task(a.id)).state, "staged");
});

test("settling a stack announces updated composition even with no staged tasks", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: [a.title] }]);
  await ctx.publish(await ctx.plan());
  const bundle = await ctx.bundleOf(a.id);
  const events: ApiComposition[] = [];
  const stop = ctx.backend.subscribe((event) => { if (event.type === "composition") events.push(event.composition); });
  t.after(stop);
  ctx.setGh({ prs: ctx.gh().prs.map((p) => ({ ...p, state: "MERGED" })) });
  dbCache(openDb(ctx.cache)).set("pr-retired", String(bundle.pr), true);
  await ctx.backend.reconcileBundles();
  assert.ok(events.some((c) => c.stacks.length === 0), "stack retirement is visible without reloading");
});

test("turning automatic grouping off cancels queued reruns but not explicit ones", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Retry validation", "Retry tests"]);
  const hold = join(ctx.tmp, "groups.json.hold");
  for (const explicit of [false, true]) {
    await ctx.backend.unstage(b.id);
    writeFileSync(hold, "hold");
    const before = ctx.groupCalls().length;
    writeFileSync(join(ctx.tmp, "groups.json"), JSON.stringify({ replies: [
      ...Array(before).fill(null),
      { groups: [{ tasks: [a.id], parent: null, rationale: "initial snapshot" }] },
      { groups: [{ tasks: [a.id, b.id], parent: null, rationale: "latest snapshot" }] },
    ] }));
    await ctx.backend.setAutoComposition(true);
    await until(() => ctx.groupCalls().length === before + 1, "first run held");
    await ctx.backend.stage(b.id);
    await new Promise((r) => setTimeout(r, 100));
    if (explicit) await ctx.backend.planComposition();
    await ctx.backend.setAutoComposition(false);
    unlinkSync(hold);
    await ctx.settled();
    assert.equal(ctx.groupCalls().length - before, explicit ? 2 : 1);
  }
});

test("an opened PR survives a failed local publication transaction and is adopted on retry", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  ctx.replyWith([{ tasks: [a.title] }]);
  const db = openDb(ctx.cache);
  db.exec("CREATE TRIGGER fail_publication BEFORE UPDATE ON tasks WHEN NEW.state = 'pr_open' BEGIN SELECT RAISE(FAIL, 'fixture publication failure'); END");
  const result = await ctx.publish(await ctx.plan());
  assert.match(result.lastResult?.error ?? "", /fixture publication failure/);
  assert.equal((await ctx.task(a.id)).state, "staged");
  assert.deepEqual(await ctx.backend.listBundles(), [], "bundle and task writes roll back together");
  db.exec("DROP TRIGGER fail_publication");
  assert.equal((await ctx.publish(await ctx.plan())).lastResult?.error, undefined);
  assert.equal(ctx.ghCreates(), 1);
  assert.equal((await ctx.backend.listBundles()).length, 1);
});

/** A committed, declared validator that passes only when README.md has both tasks' lines. */
const VALIDATOR = { "check/both.cjs": "const s = require('fs').readFileSync('README.md', 'utf8');\nprocess.exit(s.includes('alpha') && s.includes('beta') ? 0 : 1);\n" };
const BOTH_LINES = [process.execPath, "check/both.cjs"];
type BootOptions = NonNullable<Parameters<typeof boot>[1]>;
/** Boot options that let the resolver run: the validator committed at the base, declared, and checked. */
const resolving = (extra: BootOptions = {}): BootOptions => ({ conflictChecks: [BOTH_LINES], conflictValidators: ["check"], ...extra, files: { ...VALIDATOR, ...extra.files } });
const TEMPLATE = { ".github/pull_request_template.md": "## Template\n\nTrailing: metadata\n" };

/** Two staged tasks that both append a line to README.md, which conflicts additively. */
async function appended(ctx: Ctx, lines = ["alpha", "beta"], options: string | string[] = ""): Promise<Task[]> {
  await ctx.backend.setAutoComposition(false);
  const tasks: Task[] = [];
  for (const [i, line] of lines.entries()) tasks.push(await ctx.reviewed(`Append ${line}`, `append line:${line} ${Array.isArray(options) ? options[i] : options}`));
  for (const task of tasks) await ctx.backend.stage(task.id);
  return tasks;
}

test("stacked metadata is journaled and reused on recovery rather than regenerated", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t, { files: TEMPLATE });
  const [task] = await staged(ctx, ["Simplify README examples"], "append line:alpha");
  const file = join(ctx.tmp, "metadata"); withEnv(t, "FAKE_PR_COPY", file);
  const title = "docs: clarify README examples";
  writeFileSync(file, JSON.stringify({ title, summary: "Document the alpha example.", changes: [{ id: "c1", text: "Add the alpha README example." }] }));
  ctx.replyWith([{ tasks: [task.title] }]);
  ctx.setGh({ failCreateEarly: 1 });
  const result = await ctx.publish(await ctx.plan());
  assert.ok(result.lastResult!.error);
  const intent = dbCache(openDb(ctx.cache)).get<{ bundle: Bundle; body: string }>("compose-intent", task.id)!;
  assert.equal(intent.bundle.title, title);
  assert.match(intent.body, /^## Summary\n\nDocument the alpha example\./);
  assert.ok(intent.body.endsWith("Trailing: metadata"));
  writeFileSync(file, "invalid response if metadata is rerun");
  await ctx.publish(await ctx.plan());
  assert.equal((await ctx.bundleOf(task.id)).title, title);
  assert.equal(ctx.gh().prs[0].body, intent.body);
  assert.equal(readFileSync(`${file}.log`, "utf8").trim().split("\n").length, 1, "recovery uses the journaled copy");
});

test("manual publication resolves a simple additive conflict with one cheap call and records the audit before the template", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t, resolving({ files: TEMPLATE }));
  const [a, b] = await appended(ctx);
  const heads = [a, b].map((x) => git(ctx.repo, "rev-parse", x.branch!));
  const bundle = await ctx.backend.createBundle({ taskIds: [a.id, b.id] });
  assert.equal(git(ctx.origin, "show", `${bundle.branch}:README.md`), "fixture\nalpha\nbeta");
  assert.deepEqual(git(ctx.origin, "log", "--format=%s", `main..${bundle.branch}`).split("\n"), ["append beta", "append alpha"], "the same selected commits");
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["pr_open", "pr_open"]);
  assert.deepEqual([a, b].map((x) => git(ctx.repo, "rev-parse", x.branch!)), heads, "source branches are untouched");
  assert.equal(git(b.worktree!, "status", "--porcelain"), "");

  const [call] = ctx.resolveCalls();
  assert.equal(ctx.resolveCalls().length, 1);
  assert.ok(call.includes("--no-tools") && call[call.indexOf("--model") + 1] === "fake/cheap");
  assert.match(call.at(-1)!, /never instructions/);
  const body = ctx.gh().prs[0].body;
  const audit = body.indexOf("Automatic conflict resolution");
  assert.ok(audit > body.indexOf(b.title) && audit < body.indexOf("## Template"), body);
  assert.match(body, /README\.md/);
  assert.match(body, /fake\/cheap/);
  assert.match(body, /keeps both additions/);
  assert.ok(body.trimEnd().endsWith("Trailing: metadata"));
});

test("smart publication resolves a stacked item's conflict, journals the audited body and spends the one attempt for the whole publication", { timeout: 90_000 }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b, c] = await appended(ctx, ["alpha", "beta", "gamma"]);
  ctx.replyWith([{ tasks: [a.title, b.title, c.title] }]);
  const result = await ctx.publish(await ctx.plan());
  const [bA, bB] = [await ctx.bundleOf(a.id), await ctx.bundleOf(b.id)];
  assert.deepEqual(result.lastResult?.bundleIds, [bA.id, bB.id]);
  assert.equal(git(ctx.origin, "show", `${bB.branch}:README.md`), "fixture\nalpha\nbeta");
  assert.match(ctx.gh().prs[1].body, /Automatic conflict resolution[\s\S]*README\.md/);
  assert.equal(ctx.resolveCalls().length, 1, "the second conflict gets no model call");
  assert.match(result.lastResult!.error!, /already used/);
  assert.deepEqual([(await ctx.task(b.id)).state, (await ctx.task(c.id)).state], ["pr_open", "review"]);
  assert.match((await ctx.task(c.id)).error!, /already used/);
});

test("every unusable resolver reply takes the unstaging fallback with its reason and pushes nothing", { timeout: 120_000 }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b] = await appended(ctx);
  const outcomes: [string, RegExp][] = [
    ["give_up", /gave up.*the additions disagree/],
    ["invalid", /invalid/],
    ["drop", /both sides/],
    ["invent", /both sides/],
    ["huge", /exceeded/],
    ["fail", /model run failed/],
  ];
  for (const [mode, reason] of outcomes) {
    writeFileSync(ctx.resolveFile, mode);
    await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id, b.id] }), (e) => status(e) === 409 && reason.test((e as Error).message));
    const unstaged = await ctx.task(b.id);
    assert.equal(unstaged.state, "review", mode);
    assert.match(unstaged.error!, reason);
    assert.match(unstaged.error!, /README\.md/);
    assert.equal((await ctx.task(a.id)).state, "staged");
    await ctx.backend.stage(b.id);
  }
  assert.equal(ctx.resolveCalls().length, outcomes.length, "one call per confirmed publication, no retries");
  assert.equal(ctx.ghCreates(), 0);
  assert.equal(git(ctx.origin, "branch", "--list", "techtree/bundle-*"), "");
  assert.equal(git(ctx.repo, "branch", "--list", "techtree/bundle-*"), "");
});

test("checks must pass the resolution and reject each side alone", { timeout: 120_000 }, async (t) => {
  const node = (code: string) => [process.execPath, "-e", code];
  const cases: [string[][], RegExp][] = [
    [[node("process.exit(1)")], /failed on the resolution/],
    [[node("")], /cannot tell/],
  ];
  for (const [conflictChecks, reason] of cases) {
    const ctx = await boot(t, resolving({ conflictChecks }));
    const [a, b] = await appended(ctx);
    await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id, b.id] }), (e) => status(e) === 409 && reason.test((e as Error).message));
    assert.equal((await ctx.task(b.id)).state, "review");
    assert.equal(ctx.ghCreates(), 0);
  }
});

test("a check that changes the composition or a declared validator is operational drift: every task stays staged", { timeout: 120_000 }, async (t) => {
  const node = (code: string) => [process.execPath, "-e", code];
  for (const tamper of ["require('fs').appendFileSync('README.md', 'tampered\\n')", "require('fs').appendFileSync('check/both.cjs', '// weakened\\n')", "require('fs').writeFileSync('check/extra.cjs', '')", "const fs = require('fs'); fs.renameSync('check', 'real'); fs.symlinkSync('real', 'check')"]) {
    const ctx = await boot(t, resolving({ conflictChecks: [node(tamper), BOTH_LINES] }));
    const [a, b] = await appended(ctx);
    await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id, b.id] }), (e) => status(e) === 502 && /drift/.test((e as Error).message) || assert.fail((e as Error).message));
    assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"], tamper);
    assert.equal(ctx.ghCreates(), 0);
  }
});

test("conflicts outside the additive text scope, or without checks or a cheap model, give up before any model call", { timeout: 180_000 }, async (t) => {
  const cases: { why: RegExp; scenario?: string; options?: string | string[]; boot?: BootOptions; symlink?: [string, string] }[] = [
    { why: /conflictChecks/, boot: {} },
    { why: /conflictValidators/, boot: { conflictChecks: [BOTH_LINES], files: VALIDATOR } },
    { why: /conflictValidators.*missing\.cjs/, boot: resolving({ conflictValidators: ["missing.cjs"] }) },
    { why: /conflictValidators/, boot: resolving({ conflictValidators: ["../check"] }) },
    { why: /conflictValidators/, boot: resolving({ conflictValidators: ["check/*.cjs"] }) },
    { why: /conflictValidators.*link\.cjs/, boot: resolving({ conflictValidators: ["link.cjs"] }), symlink: ["check/both.cjs", "link.cjs"] },
    { why: /conflictValidators.*linkdir/, boot: resolving({ conflictValidators: ["linkdir/both.cjs"] }), symlink: ["check", "linkdir"] },
    { why: /declared validator/, options: "files:validator.cjs", boot: resolving({ conflictChecks: [[process.execPath, "runner.cjs"]], conflictValidators: ["runner.cjs", "validator.cjs"], files: { "runner.cjs": "require('./validator.cjs');\n", "validator.cjs": "'use strict';\n" } }) },
    { why: /declared validator/, options: ["files:README.md,check/both.cjs", ""] },
    { why: /declared validator/, options: ["files:README.md,check/new.cjs", ""] },
    { why: /cheap model/, boot: resolving({ titleModel: null }) },
    { why: /name a conflicted file/, boot: resolving({ conflictChecks: [[process.execPath, "--check", "./README.md"]] }) },
    { why: /additive/, scenario: "readme" },
    { why: /lockfile or dependency manifest/, options: "files:Cargo.lock", boot: resolving({ files: { "Cargo.lock": "# lock\n" } }) },
    { why: /binary|NUL/, options: "files:data.bin", boot: resolving({ files: { "data.bin": "a\0b\n" } }) },
    { why: /stages/, options: "files:NEW.md" },
    { why: /stages/, scenario: "move" },
    { why: /more than 3 files/, options: "files:a.txt,b.txt,c.txt,d.txt", boot: resolving({ files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" } }) },
    { why: /200 conflicting lines/, options: "lines:150" },
    { why: /32 KiB/, options: "lines:40 width:500" },
  ];
  for (const c of cases) {
    const ctx = await boot(t, c.boot ?? resolving());
    if (c.symlink) {
      symlinkSync(c.symlink[0], join(ctx.repo, c.symlink[1]));
      git(ctx.repo, "add", c.symlink[1]);
      git(ctx.repo, "commit", "-qm", "link");
      git(ctx.repo, "push", "-q", "origin", "main");
    }
    let tasks: Task[];
    if (c.scenario === "readme") tasks = await staged(ctx, ["Readme A", "Readme B"], "readme");
    else if (c.scenario === "move") {
      await ctx.backend.setAutoComposition(false);
      tasks = [await ctx.reviewed("Move A", "move file:README.md to:A.md"), await ctx.reviewed("Move B", "move file:README.md to:B.md")];
      for (const x of tasks) await ctx.backend.stage(x.id);
    }
    else tasks = await appended(ctx, ["alpha", "beta"], c.options ?? "");
    await assert.rejects(ctx.backend.createBundle({ taskIds: tasks.map((x) => x.id) }), (e) => status(e) === 409 && c.why.test((e as Error).message) || assert.fail(`${c.why}: ${(e as Error).message}`));
    assert.equal(ctx.resolveCalls().length, 0, String(c.why));
    assert.equal((await ctx.task(tasks[1].id)).state, "review");
  }
});

test("source drift while the resolver runs is a plain failure that keeps every task staged, even when the model gives up", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b] = await appended(ctx);
  writeFileSync(ctx.resolveFile, "give_up");
  writeFileSync(`${ctx.resolveFile}.hold`, "");
  const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
  await until(() => ctx.resolveCalls().length === 1, "the resolver call");
  writeFileSync(join(a.worktree!, "late.txt"), "late\n");
  git(a.worktree!, "add", "-A");
  git(a.worktree!, "commit", "-qm", "late change");
  unlinkSync(`${ctx.resolveFile}.hold`);
  await assert.rejects(publishing, (e) => status(e) === 502 && /changed/.test((e as Error).message) && !/unstaged/.test((e as Error).message));
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"]);
  assert.equal((await ctx.task(b.id)).error, undefined);
  assert.equal(ctx.ghCreates(), 0);
  assert.equal(git(ctx.repo, "branch", "--list", "techtree/bundle-*"), "");
});

test("shutdown during a resolver call kills the model's process group and leaves the tasks staged", { timeout: 60_000, skip: process.platform === "win32" }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b] = await appended(ctx);
  writeFileSync(ctx.resolveFile, "orphan");
  const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
  const child = await until(() => (existsSync(`${ctx.resolveFile}.child`) ? Number(readFileSync(`${ctx.resolveFile}.child`, "utf8")) : undefined), "the model's child");
  await ctx.backend.close();
  await assert.rejects(publishing, (e) => status(e) === 502 && /stopped/.test((e as Error).message));
  for (const pid of [child, Number(readFileSync(`${ctx.resolveFile}.pid`, "utf8"))]) assert.throws(() => process.kill(pid, 0), "no resolver process survives shutdown");
  const db = openDb(ctx.cache);
  t.after(() => db.close());
  const states = (db.prepare("SELECT data FROM tasks").all() as { data: string }[]).map((r) => JSON.parse(r.data).state);
  assert.deepEqual(states, ["staged", "staged"]);
  assert.equal(ctx.ghCreates(), 0);
});

test("a manual replay with no net change is refused before push or PR creation", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a] = await staged(ctx, ["Retry validation"]);
  git(a.worktree!, "revert", "--no-edit", "HEAD");
  await assert.rejects(ctx.backend.createBundle({ taskIds: [a.id] }), (e) => status(e) === 502 && /changes nothing/.test((e as Error).message));
  assert.equal(ctx.ghCreates(), 0);
  assert.equal(git(ctx.origin, "branch", "--list", "techtree/bundle-*"), "");
  assert.equal((await ctx.task(a.id)).state, "staged");
});

test("a stack parent that changes while the resolver runs fails the item plainly and keeps it staged", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b] = await appended(ctx);
  ctx.replyWith([{ tasks: [a.title, b.title] }]);
  const proposal = await ctx.plan();
  writeFileSync(`${ctx.resolveFile}.hold`, "");
  const publishing = ctx.publish(proposal);
  await until(() => ctx.resolveCalls().length === 1, "the resolver call");
  ctx.setGh({ prs: ctx.gh().prs.map((p) => ({ ...p, headRefOid: "0".repeat(40) })) });
  unlinkSync(`${ctx.resolveFile}.hold`);
  const result = await publishing;
  assert.match(result.lastResult!.error!, /parent PR #\d+ changed/);
  assert.doesNotMatch(result.lastResult!.error!, /unstaged/);
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["pr_open", "staged"]);
  assert.equal(ctx.ghCreates(), 1);
});

/** Hold the fake model's reply until `during` has run, then let it answer `reply`. */
async function whileResolving(ctx: Ctx, reply: string, during: () => void | Promise<void>): Promise<void> {
  writeFileSync(ctx.resolveFile, reply);
  writeFileSync(`${ctx.resolveFile}.hold`, "");
  await until(() => ctx.resolveCalls().length === 1, "the resolver call");
  await during();
  unlinkSync(`${ctx.resolveFile}.hold`);
}

test("changes to the composition worktree while the model runs are operational drift on success and give-up alike", { timeout: 120_000 }, async (t) => {
  const changes: [string, (wt: string) => void][] = [
    ["union", (wt) => { writeFileSync(join(wt, "src/util/mod.rs"), "fn changed() {}\n"); git(wt, "add", "src/util/mod.rs"); }],
    ["give_up", (wt) => writeFileSync(join(wt, "README.md"), "rewritten while waiting\n")],
  ];
  for (const [reply, change] of changes) {
    const ctx = await boot(t, resolving());
    const [a, b] = await appended(ctx);
    const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
    await whileResolving(ctx, reply, () => change(ctx.bundleWorktree()!));
    await assert.rejects(publishing, (e) => status(e) === 502 && /drift/.test((e as Error).message) || assert.fail((e as Error).message));
    assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"], reply);
    assert.equal(ctx.ghCreates(), 0);
    assert.equal(git(ctx.repo, "branch", "--list", "techtree/bundle-*"), "");
  }
});

test("a conflict-free manual publication still refuses a source branch that moved after the request", { timeout: 60_000 }, async (t) => {
  const ctx = await boot(t);
  const [a, b] = await staged(ctx, ["Retry validation", "Tree colors"]);
  const realGit = join(git(ctx.repo, "--exec-path"), "git");
  const hold = join(ctx.tmp, "fetch.hold");
  writeFileSync(join(ctx.tmp, "bin", "git"), `#!/bin/sh\nif [ "$1" = "fetch" ] && [ -f ${JSON.stringify(hold)} ]; then touch ${JSON.stringify(`${hold}.waiting`)}; while [ -f ${JSON.stringify(hold)} ]; do sleep 0.05; done; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(ctx.tmp, "bin", "git"), 0o755);
  writeFileSync(hold, "");
  const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
  await until(() => existsSync(`${hold}.waiting`), "the held fetch");
  writeFileSync(join(a.worktree!, "late.txt"), "late\n");
  git(a.worktree!, "add", "-A");
  git(a.worktree!, "commit", "-qm", "late source change");
  unlinkSync(hold);
  await assert.rejects(publishing, (e) => status(e) === 502 && /changed/.test((e as Error).message));
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"]);
  assert.equal(ctx.ghCreates(), 0);
});

test("drift in another selected task overrides a stacked item's give-up and keeps the unpublished tasks staged", { timeout: 90_000 }, async (t) => {
  const ctx = await boot(t, resolving());
  const [a, b] = await appended(ctx);
  const [c] = await staged(ctx, ["Tree colors"]);
  ctx.replyWith([{ tasks: [a.title, b.title] }, { tasks: [c.title] }]);
  const proposal = await ctx.plan();
  const publishing = ctx.publish(proposal);
  await whileResolving(ctx, "give_up", () => {
    writeFileSync(join(c.worktree!, "late.txt"), "late\n");
    git(c.worktree!, "add", "-A");
    git(c.worktree!, "commit", "-qm", "late sibling change");
  });
  const result = await publishing;
  assert.match(result.lastResult!.error!, /changed/);
  assert.doesNotMatch(result.lastResult!.error!, /unstaged/);
  assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state, (await ctx.task(c.id)).state], ["pr_open", "staged", "staged"]);
});

test("shutdown or source drift during the parent check after a give-up still keeps the stacked item staged", { timeout: 120_000 }, async (t) => {
  for (const event of ["shutdown", "drift"]) {
    const ctx = await boot(t, resolving());
    const [a, b] = await appended(ctx);
    ctx.replyWith([{ tasks: [a.title, b.title] }]);
    const proposal = await ctx.plan();
    const publishing = ctx.publish(proposal);
    const viewHold = `${ctx.ghState}.view-hold`;
    await whileResolving(ctx, "give_up", () => writeFileSync(viewHold, ""));
    await until(() => existsSync(`${ctx.ghState}.view-waiting`), "the held parent check");
    let closing: Promise<void> | undefined;
    if (event === "shutdown") closing = ctx.backend.close();
    else {
      writeFileSync(join(b.worktree!, "late.txt"), "late\n");
      git(b.worktree!, "add", "-A");
      git(b.worktree!, "commit", "-qm", "late change");
    }
    unlinkSync(viewHold);
    const result = await publishing;
    await closing;
    assert.match(result.lastResult!.error!, event === "shutdown" ? /stopped/ : /changed/);
    assert.doesNotMatch(result.lastResult!.error!, /unstaged/);
    const db = openDb(ctx.cache);
    const states = Object.fromEntries((db.prepare("SELECT id, data FROM tasks").all() as { id: string; data: string }[]).map((r) => [r.id, JSON.parse(r.data).state]));
    db.close();
    assert.deepEqual([states[a.id], states[b.id]], ["pr_open", "staged"], event);
  }
});

test("shutdown or source drift while a conflict's temporary bundle is cleaned up overrides the unstaging fallback", { timeout: 120_000 }, async (t) => {
  for (const event of ["drift", "shutdown"]) {
    const ctx = await boot(t, resolving());
    const [a, b] = await appended(ctx);
    writeFileSync(ctx.resolveFile, "give_up");
    const realGit = join(git(ctx.repo, "--exec-path"), "git");
    const hold = join(ctx.tmp, "cleanup.hold");
    writeFileSync(join(ctx.tmp, "bin", "git"), `#!/bin/sh\nif [ "$1 $2" = "worktree remove" ] && [ -f ${JSON.stringify(hold)} ]; then touch ${JSON.stringify(`${hold}.waiting`)}; while [ -f ${JSON.stringify(hold)} ]; do sleep 0.05; done; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(ctx.tmp, "bin", "git"), 0o755);
    writeFileSync(hold, "");
    const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
    publishing.catch(() => {});
    await until(() => existsSync(`${hold}.waiting`), "the held cleanup");
    let closing: Promise<void> | undefined;
    if (event === "shutdown") closing = ctx.backend.close();
    else {
      writeFileSync(join(a.worktree!, "late.txt"), "late\n");
      git(a.worktree!, "add", "-A");
      git(a.worktree!, "commit", "-qm", "late change");
    }
    unlinkSync(hold);
    await assert.rejects(publishing, (e) => (event === "shutdown" ? /stopped/ : /changed/).test((e as Error).message) && !/unstaged/.test((e as Error).message) || assert.fail((e as Error).message));
    await closing;
    const db = openDb(ctx.cache);
    const states = Object.fromEntries((db.prepare("SELECT id, data FROM tasks").all() as { id: string; data: string }[]).map((r) => [r.id, JSON.parse(r.data).state]));
    db.close();
    assert.deepEqual([states[a.id], states[b.id]], ["staged", "staged"], event);
  }
});

test("a declared validator changed while the model runs is operational drift before any outcome or check, so a new validator never executes", { timeout: 120_000 }, async (t) => {
  const node = (code: string) => [process.execPath, "-e", code];
  const discover = node("for (const f of require('fs').readdirSync('check').sort()) require(require('path').resolve('check', f))");
  const cases: [string, (wt: string, marker: string) => void][] = [
    ["give_up", (wt, marker) => writeFileSync(join(wt, "check/a-new.cjs"), `require('fs').writeFileSync(${JSON.stringify(marker)}, '');\n`)],
    ["union", (wt, marker) => writeFileSync(join(wt, "check/a-new.cjs"), `require('fs').writeFileSync(${JSON.stringify(marker)}, '');\n`)],
    ["union", (wt) => { renameSync(join(wt, "check"), join(wt, "real")); symlinkSync("real", join(wt, "check")); }],
  ];
  for (const [reply, change] of cases) {
    const ctx = await boot(t, resolving({ conflictChecks: [discover] }));
    const marker = join(ctx.tmp, "new-validator-ran");
    const [a, b] = await appended(ctx);
    const publishing = ctx.backend.createBundle({ taskIds: [a.id, b.id] });
    publishing.catch(() => {});
    await whileResolving(ctx, reply, () => change(ctx.bundleWorktree()!, marker));
    await assert.rejects(publishing, (e) => status(e) === 502 && /drift/.test((e as Error).message) || assert.fail(`${reply}: ${(e as Error).message}`));
    assert.deepEqual([(await ctx.task(a.id)).state, (await ctx.task(b.id)).state], ["staged", "staged"], reply);
    assert.equal(existsSync(marker), false, "the inserted validator never runs");
    assert.equal(ctx.ghCreates(), 0);
  }
});
