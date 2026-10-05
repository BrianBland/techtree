import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, terminalArgv } from "../../src/backend/terminal.ts";

test("shellQuote single-quotes every word, including embedded quotes", () => {
  assert.equal(shellQuote(["pi", "--model", "a b", "it's"]), `'pi' '--model' 'a b' 'it'\\''s'`);
});

test("on macOS the default opens Terminal.app on the command in the worktree", () => {
  const argv = terminalArgv({ platform: "darwin", cwd: '/w/"x"', command: "'pi'" })!;
  assert.deepEqual(argv, [
    "osascript",
    "-e", `tell application "Terminal" to do script "cd '/w/\\"x\\"' && 'pi'"`,
    "-e", `tell application "Terminal" to activate`,
  ]);
  assert.match(terminalArgv({ platform: "darwin", cwd: "/w", command: "" })![2], /do script "cd '\/w'"$/);
});

test("on Linux the default runs the command in x-terminal-emulator and leaves a shell open", () => {
  assert.deepEqual(terminalArgv({ platform: "linux", cwd: "/w", command: "'pi'" }), [
    "x-terminal-emulator", "-e", "sh", "-c", `cd '/w' && 'pi'; exec "\${SHELL:-/bin/sh}"`,
  ]);
  assert.deepEqual(terminalArgv({ platform: "linux", cwd: "/w", command: "" })!.at(-1), `cd '/w'; exec "\${SHELL:-/bin/sh}"`);
});

test("other platforms have no default", () => {
  assert.equal(terminalArgv({ platform: "win32", cwd: "C:\\w", command: "" }), undefined);
});

test("a configured template substitutes {cwd} and {command} and drops elements left empty", () => {
  const template = ["wezterm", "start", "--cwd", "{cwd}", "--", "sh", "-c", "{command}"];
  assert.deepEqual(terminalArgv({ template, platform: "win32", cwd: "/w", command: "'pi' '-c'" }), [
    "wezterm", "start", "--cwd", "/w", "--", "sh", "-c", "'pi' '-c'",
  ]);
  assert.deepEqual(terminalArgv({ template, platform: "darwin", cwd: "/w", command: "" }), ["wezterm", "start", "--cwd", "/w", "--", "sh", "-c"]);
});

test("template values are inserted literally, in one pass", () => {
  assert.deepEqual(terminalArgv({ template: ["t", "{cwd}", "--", "{command}"], platform: "linux", cwd: "/w/a$&b$`c$'{command}", command: "'a$&b' '$1'" }), [
    "t", "/w/a$&b$`c$'{command}", "--", "'a$&b' '$1'",
  ]);
});

test("hostile worktree paths and arguments reach the shell quoted", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "techtree-quote-")));
  try {
    const cwd = join(tmp, `it's $(touch pwned) "x"`);
    mkdirSync(cwd);
    const script = terminalArgv({ platform: "linux", cwd, command: shellQuote(["printf", "%s|", "a b", "$(touch pwned2)"]) })!.at(-1)!;
    const out = execFileSync("sh", ["-c", script], { cwd: tmp, encoding: "utf8", env: { ...process.env, SHELL: "true" } });
    assert.equal(out, "a b|$(touch pwned2)|");
    assert.equal(existsSync(join(tmp, "pwned")) || existsSync(join(cwd, "pwned2")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
