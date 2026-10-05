import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Tree } from "../../src/types.ts";

/** A tree with the given directory ids (ancestors included automatically). */
export function makeTree(...ids: string[]): Tree {
  const nodes: Tree["nodes"] = { "": { id: "", name: "repo", kind: "dir", parent: null, children: [], files: [] } };
  const add = (id: string): void => {
    if (nodes[id]) return;
    const parent = dirname(id) === "." ? "" : dirname(id);
    add(parent);
    nodes[id] = { id, name: basename(id), kind: "dir", parent, children: [], files: [] };
    nodes[parent].children.push(id);
  };
  ids.forEach(add);
  return { repoRoot: "/repo", nodes };
}

export const DAY = 24 * 3600 * 1000;
export const T0 = Date.parse("2025-01-10T00:00:00Z");

/** One PR as `gh pr list --json ...` returns it. */
export function ghPr(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    author: { login: "me" },
    files: [{ path: "src/a.ts", additions: 10, deletions: 2 }],
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewDecision: "REVIEW_REQUIRED",
    reviews: [],
    updatedAt: new Date(T0).toISOString(),
    mergeable: "MERGEABLE",
    headRefName: `branch-${number}`,
    headRefOid: "sha1",
    state: "OPEN",
    ...over,
  };
}

export interface FakeGh {
  gh: string[];
  setUser(login: string | null): void;
  setList(prs: Record<string, unknown>[]): void;
  setView(number: number, pr: Record<string, unknown>): void;
  setFail(message: string | null): void;
  calls(): string[];
}

export function fakeGh(t: TestContext): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "techtree-gh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, content: string | null) =>
    content === null ? rmSync(join(dir, name), { force: true }) : writeFileSync(join(dir, name), content);
  put("user", "me\n");
  put("list.json", "[]");
  return {
    gh: [process.execPath, join(import.meta.dirname, "fake-gh.mjs"), dir],
    setUser: (login) => put("user", login === null ? null : `${login}\n`),
    setList: (prs) => put("list.json", JSON.stringify(prs)),
    setView: (number, pr) => put(`view-${number}.json`, JSON.stringify(pr)),
    setFail: (message) => put("fail", message),
    calls: () => {
      try {
        return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
