import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { gitPlugin } from "../../src/plugins/git.ts";
import { buildTree, fixture, git, makeCtx, memoryCache, script, writeFiles } from "./helpers.ts";

const DAY = 86_400;

function commit(root: string, files: Record<string, string>, author: string, daysAgo: number) {
  writeFiles(root, files);
  const date = `${Math.floor(Date.now() / 1000) - daysAgo * DAY} +0000`;
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "c"], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author}@example.com`,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: `${author}@example.com`,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

function repo(): string {
  const root = fixture({});
  git(root, ["init", "-q"]);
  commit(root, { "old/a.txt": "1\n2\n3\n", "hot/b.txt": "1\n" }, "ann", 200);
  commit(root, { "hot/b.txt": "1\n2\n3\n" }, "bob", 30);
  commit(root, { "hot/b.txt": "3\n", "hot/c.txt": "x\n" }, "cid", 5);
  return root;
}

function withFakeGh(body: string): () => void {
  const bin = fixture({});
  script(join(bin, "gh"), body);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return () => (process.env.PATH = saved);
}

test("churn, authors and last-touched come from git history per directory", async () => {
  const root = repo();
  const values = await gitPlugin.collect(makeCtx(buildTree(root)));
  assert.deepEqual(values["old"], { churn_90d: 0, authors_90d: 0, last_touched_days: 200, open_pr_overlap: 0 });
  // bob: +2; cid: +0/-2 on b.txt and +1 on c.txt
  assert.deepEqual(values["hot"], { churn_90d: 5, authors_90d: 2, last_touched_days: 5, open_pr_overlap: 0 });
  assert.equal(values[""], undefined);
});

test("open PRs touching a directory are counted once per PR when the repo has a GitHub remote", async (t) => {
  const root = repo();
  git(root, ["remote", "add", "origin", "git@github.com:example/repo.git"]);
  t.after(
    withFakeGh(`echo '[{"number":1,"files":[{"path":"hot/b.txt"},{"path":"hot/c.txt"}]},{"number":2,"files":[{"path":"hot/b.txt"},{"path":"old/a.txt"}]}]'`),
  );
  const cache = memoryCache();
  const values = await gitPlugin.collect(makeCtx(buildTree(root), { cache }));
  assert.equal(values["hot"].open_pr_overlap, 2);
  assert.equal(values["old"].open_pr_overlap, 1);
});

test("open PR lists are cached, so a failing gh within the cache window keeps the counts", async (t) => {
  const root = repo();
  git(root, ["remote", "add", "origin", "https://github.com/example/repo"]);
  const cache = memoryCache();
  const restore = withFakeGh(`echo '[{"number":7,"files":[{"path":"old/a.txt"}]}]'`);
  await gitPlugin.collect(makeCtx(buildTree(root), { cache }));
  restore();
  t.after(withFakeGh("exit 1"));
  const values = await gitPlugin.collect(makeCtx(buildTree(root), { cache }));
  assert.equal(values["old"].open_pr_overlap, 1);
});

test("open_pr_overlap is silently 0 when gh fails or there is no GitHub remote", async (t) => {
  const root = repo();
  const restore = withFakeGh(`echo '[{"number":1,"files":[{"path":"hot/b.txt"}]}]'`);
  const noRemote = await gitPlugin.collect(makeCtx(buildTree(root)));
  restore();
  assert.equal(noRemote["hot"].open_pr_overlap, 0);

  git(root, ["remote", "add", "origin", "git@github.com:example/repo.git"]);
  t.after(withFakeGh("echo boom >&2; exit 1"));
  const failing = await gitPlugin.collect(makeCtx(buildTree(root)));
  assert.equal(failing["hot"].open_pr_overlap, 0);
});

test("a directory outside git yields no values and a log line instead of failing", async () => {
  const root = fixture({ "a.txt": "x\n" });
  const logs: string[] = [];
  assert.deepEqual(await gitPlugin.collect(makeCtx(buildTree(root), { logs })), {});
  assert.equal(logs.length, 1);
});

test("only history of files in the tree counts: excluded and deleted files are ignored", async () => {
  const root = repo();
  commit(root, { "hot/gone.txt": "1\n2\n3\n4\n5\n" }, "dan", 3);
  git(root, ["rm", "-q", "hot/gone.txt"]);
  commit(root, {}, "dan", 2);
  const tree = buildTree(root);
  tree.nodes["hot"].files = ["hot/c.txt"];
  tree.nodes["old"].files = [];
  const values = await gitPlugin.collect(makeCtx(tree));
  assert.deepEqual(values["hot"], { churn_90d: 1, authors_90d: 1, last_touched_days: 5, open_pr_overlap: 0 });
  assert.equal(values["old"], undefined);
});
