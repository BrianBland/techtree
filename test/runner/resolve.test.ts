import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiPrint } from "../../src/plugins/llm-scan.ts";
import { parseResolution, runCheck, type Hunk } from "../../src/runner/resolve.ts";

const hunk = (id: string, base: string[], ours: string[], theirs: string[]): Hunk => ({ id, path: "f.ts", before: [], base, ours, theirs, after: [] });
const resolved = (hunks: { id: string; lines: unknown }[], extra = {}) => JSON.stringify({ outcome: "resolved", hunks, reason: "both", ...extra });

test("a resolution must keep exactly both sides' lines, each side in order, for every host-issued hunk", () => {
  const imports = hunk("h1", [], ["import b;", "import d;"], ["import c;", "import e;"]);
  const shared = hunk("h2", [], ["x", "y"], ["y", "z"]);
  const based = hunk("h3", ["k"], ["k", "m"], ["n", "k"]);
  const hunks = [imports, shared, based];
  const valid = [
    { id: "h1", lines: ["import b;", "import c;", "import d;", "import e;"] },
    { id: "h2", lines: ["x", "y", "y", "z"] },
    { id: "h3", lines: ["n", "k", "m"] },
  ];
  const ok = resolved(valid);
  assert.deepEqual(parseResolution("```json\n" + ok + "\n```", hunks), {
    outcome: "resolved",
    reason: "both",
    lines: { h1: ["import b;", "import c;", "import d;", "import e;"], h2: ["x", "y", "y", "z"], h3: ["n", "k", "m"] },
  });
  assert.deepEqual(parseResolution(JSON.stringify({ outcome: "give_up", reason: "unclear" }), hunks), { outcome: "give_up", reason: "unclear" });

  const replace = (id: string, lines: unknown) => resolved(valid.map((h) => (h.id === id ? { id, lines } : h)));
  const invalid: [string, string][] = [
    [replace("h1", ["import b;", "import d;"]), "drops a side"],
    [replace("h1", ["import b;", "import d;", "import c;", "import e;", "evil();"]), "invents a line"],
    [replace("h2", ["x", "y", "z", "evil"]), "shared addition leaves room for an invented line under a length-only rule"],
    [replace("h1", ["import d;", "import b;", "import c;", "import e;"]), "reorders a side"],
    [replace("h3", ["k", "n", "k", "m"]), "revives a base line twice"],
    [replace("h3", ["n", "m"]), "drops a base line"],
    [replace("h1", ["import b;\nimport c;", "import d;", "import e;"]), "smuggles a newline"],
    [replace("h1", "import b;"), "lines is not a list"],
    [resolved(valid.slice(0, 2)), "a hunk is missing"],
    [resolved([...valid, { id: "h9", lines: [] }]), "unknown hunk id"],
    [resolved([...valid, valid[0]]), "duplicate id"],
    [ok.replace('"reason":"both"', `"reason":"${"x".repeat(301)}"`), "overlong reason"],
    [JSON.stringify({ outcome: "give_up" }), "give_up without a reason"],
    [JSON.stringify({ outcome: "give_up", reason: "x", hunks: [] }), "give_up with extra keys"],
    [resolved(valid, { confidence: 1 }), "resolved with extra keys"],
    [resolved(valid.map((h) => (h.id === "h1" ? { ...h, path: "../x" } : h))), "a hunk with extra keys"],
    [JSON.stringify({ outcome: "merged", reason: "x" }), "unknown outcome"],
    [`Sure: ${ok}`, "prose around the JSON"],
    ["", "empty"],
  ];
  for (const [output, why] of invalid) assert.equal(typeof parseResolution(output, hunks), "string", why);
});

/** A wrapper that starts a long-lived grandchild (with `stdio`) and records its pid, then behaves as `then`. */
function wrapper(pidFile: string, then: string, stdio = "ignore"): string[] {
  const script = `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "${stdio}" }); c.unref(); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); ${then}`;
  return [process.execPath, "-e", script];
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a check runs as argv in its own process group: exit codes count, and timeouts and stray descendants are killed before it settles", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-checks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  assert.equal(await runCheck([process.execPath, "-e", "process.exit(3)"], dir, 5000), 3);
  assert.equal(await runCheck(wrapper(pidFile, ""), dir, 5000), 0);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "a descendant of a passing check is reaped");
  await assert.rejects(runCheck(wrapper(pidFile, "setInterval(() => {}, 1000);"), dir, 300), /timed out/);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "a timed-out check's descendants are reaped");
  await assert.rejects(runCheck([process.execPath, "-e", "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000)"], dir, 5000), /output/);
  const stop = new AbortController();
  const aborted = runCheck(wrapper(pidFile, "setInterval(() => {}, 1000);"), dir, 5000, stop.signal);
  setTimeout(() => stop.abort(new Error("stopping")), 200);
  await assert.rejects(aborted, /stopping/);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "an aborted check's descendants are reaped");
  await assert.rejects(runCheck([join(dir, "missing-program")], dir, 5000), /could not start/);
  assert.equal(await runCheck(wrapper(pidFile, "", "inherit"), dir, 3000), 0, "a descendant holding the output pipes does not turn a pass into a timeout");
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});

test("the print runner can own a process group, so a timeout also reaps what the pi wrapper started", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "techtree-pi-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  const [node, ...args] = wrapper(pidFile, "setInterval(() => {}, 1000);");
  await assert.rejects(runPiPrint([node, ...args, "--"], dir, [], 300, undefined, { processGroup: true }), /timed out/);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  const [node2, ...printing] = wrapper(pidFile, "console.log('ok');", "inherit");
  assert.equal(await runPiPrint([node2, ...printing, "--"], dir, [], 3000, undefined, { processGroup: true }), "ok\n", "a descendant holding the pipes does not stall a successful run");
  assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
});
