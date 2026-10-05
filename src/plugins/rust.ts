import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { CollectCtx, Effort, Finding, MetricPlugin, MetricValues, NodeId, Tree } from "../types.ts";
import { findingId, nodeOfFile, readSource, run, treeFiles } from "./util/source.ts";

type FileKind = "src" | "test" | "aux";

interface FileStats {
  file: string;
  kind: FileKind;
  fns: number;
  pubFns: string[];
  branches: number;
  unwraps: number;
  unwrapWeight: number;
  firstUnwrapLine?: number;
  tests: number;
  ignored: number;
  testCode: string;
}

interface Diagnostic {
  file: string;
  line: number;
  rule: string;
  message: string;
  error: boolean;
  machineApplicable: boolean;
  snippet: string;
}

interface Crate {
  node: NodeId;
  name: string;
  files: string[];
}

interface Analysis {
  files: FileStats[];
  crates: Crate[];
  crateOf: Map<NodeId, Crate>;
  lints: Map<NodeId, Diagnostic[]>; // by crate node; only crates that linted cleanly
}

interface RustOptions {
  clippy?: boolean;
  clippyArgs?: string[] | string;
  exclude?: string[];
}

export const TEST_ATTR = /#\[\s*(?:(?:[\w:]+::)?test|rstest)\b[^\]]*\]/g;
const IGNORE_ATTR = /#\[\s*ignore\b/g;
const FN = /\bfn\s+[A-Za-z_]\w*/g;
const PUB_FN = /\bpub\s+(?:const\s+|async\s+|unsafe\s+|extern\s+(?:"[^"]*"\s+)?)*fn\s+([A-Za-z_]\w*)/g;
const BRANCH = /\b(?:if|match|while|loop)\b|&&|\|\||\bfor\s+[^{;]*?\bin\b/g;
const UNWRAP = /\.unwrap\(\)|\.expect\(/g;
const LOCK_GUARD = /\.(?:lock|read|write)\(\)\s*$/;
const LITERAL_PARSE = /"[^"\n]*"\s*\.parse(?:::<[^()]*>)?\(\)\s*$/;
const ENTRY_POINT = /(^|\/)(main|build)\.rs$|(^|\/)src\/bin\//;
const IDENT = /[A-Za-z_]\w*/g;

/** How likely an unwrap/expect at `index` is a real panic risk (DESIGN "Confidence"). */
function unwrapWeight(code: string, index: number): number {
  const before = code.slice(Math.max(0, index - 200), index);
  if (LOCK_GUARD.test(before) || LITERAL_PARSE.test(before)) return 0.2;
  return code.startsWith(".expect(", index) ? 0.6 : 1;
}

/** Rust source with comments and string/char literal contents blanked to spaces (offsets and newlines kept). */
export function stripRust(src: string): string {
  return lexRust(src).code;
}

/** `code` as `stripRust` returns it, plus the [start, end) offsets of every comment in `src`. */
export function lexRust(src: string): { code: string; comments: [number, number][] } {
  const comments: [number, number][] = [];
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const rawStart = /b?r(#*)"/y;
  const charLit = /'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/uy;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const eol = src.indexOf("\n", i);
      const end = eol < 0 ? src.length : eol;
      blank(i, end);
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") (depth++, (j += 2));
        else if (src[j] === "*" && src[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      blank(i, j);
      comments.push([i, j]);
      i = j;
      continue;
    }
    if ((c === "r" || c === "b") && !/\w/.test(src[i - 1] ?? "")) {
      rawStart.lastIndex = i;
      const m = rawStart.exec(src);
      if (m) {
        const close = '"' + m[1];
        const end = src.indexOf(close, rawStart.lastIndex);
        const stop = end < 0 ? src.length : end;
        blank(rawStart.lastIndex, stop);
        i = stop + close.length;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      charLit.lastIndex = i;
      const m = charLit.exec(src);
      if (m) {
        blank(i + 1, i + m[0].length - 1);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return { code: out.join(""), comments };
}

/** Offset just past the `}` closing the `{` at `open`, or the end of `code`. */
export function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}" && --depth === 0) return j + 1;
  }
  return code.length;
}

const CFG_ATTR = /#(!?)\[\s*cfg\s*\(/g;
const TEST_FEATURES = new Set(["test-utils", "test_utils", "testing", "test-helpers", "test-support"]);
const TEST_DIRS = new Set(["tests", "test_utils", "testing", "test_helpers", "fixtures", "mock", "mocks"]);
const TEST_FILE = /^(?:tests|test_utils|testing|test_helpers|fixtures|mocks?|test_\w+|\w+_tests?)\.rs$/;
const TEST_SUPPORT_SEGMENT = /^(?:tests?|testing|testsuite|harness|e2e|fixtures|mocks?)$/;

/** Whether a `cfg` predicate (the text inside `cfg(…)`) holds only in test or test-support builds. */
export function testOnlyCfg(predicate: string): boolean {
  const tokens = predicate.match(/[A-Za-z_]\w*|"[^"]*"|[(),=]/g) ?? [];
  let i = 0;
  const parse = (): boolean => {
    const name = tokens[i++];
    if (tokens[i] === "=") {
      i++;
      return name === "feature" && TEST_FEATURES.has(tokens[i++]?.slice(1, -1) ?? "");
    }
    if (tokens[i] !== "(") return name === "test";
    i++;
    const args: boolean[] = [];
    while (i < tokens.length && tokens[i] !== ")") {
      args.push(parse());
      if (tokens[i] === ",") i++;
    }
    i++;
    if (name === "all") return args.some(Boolean);
    return name === "any" && args.length > 0 && args.every(Boolean);
  };
  return parse();
}

/** Offset just past the bracket closing the one at `open` (`(` or `[`), or the end of `code`. */
function closingBracket(code: string, open: number): number {
  const [o, c] = code[open] === "[" ? ["[", "]"] : ["(", ")"];
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === o) depth++;
    else if (code[j] === c && --depth === 0) return j + 1;
  }
  return code.length;
}

/** End of the item starting at `start`: past its `;` or its matching `}`, whichever comes first at bracket depth 0. */
function itemEnd(code: string, start: number): number {
  let depth = 0;
  for (let j = start; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === ";") return j + 1;
    else if (depth === 0 && c === "{") return matchingBrace(code, j);
  }
  return code.length;
}

interface TestRegions {
  /** The file is test-only (inner `#![cfg(test)]`). */
  wholeFile: boolean;
  regions: [number, number][];
  /** Names of out-of-line test-only modules (`#[cfg(test)] mod name;`). */
  modules: string[];
}

/**
 * Test regions of a Rust file: items under a test-only `cfg` and test fns. `code` is the stripped
 * source (see `stripRust`) and `src` the original, read at the same offsets for `cfg` predicates.
 */
export function testRegions(code: string, src: string): TestRegions {
  const found: TestRegions = { wholeFile: false, regions: [], modules: [] };
  for (const m of code.matchAll(CFG_ATTR)) {
    const open = m.index + m[0].length - 1;
    if (!testOnlyCfg(src.slice(open + 1, closingBracket(code, open) - 1))) continue;
    if (m[1] === "!") {
      found.wholeFile = true;
      continue;
    }
    let start = closingBracket(code, code.indexOf("[", m.index));
    for (;;) {
      start += code.slice(start).search(/\S|$/);
      if (code[start] !== "#") break;
      start = closingBracket(code, code.indexOf("[", start));
    }
    const end = itemEnd(code, start);
    found.regions.push([m.index, end]);
    const mod = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;$/.exec(code.slice(start, end));
    if (mod) found.modules.push(mod[1]);
  }
  const nextFn = /\bfn\b/g;
  for (const m of code.matchAll(TEST_ATTR)) {
    nextFn.lastIndex = m.index;
    const fn = nextFn.exec(code);
    if (fn) found.regions.push([m.index, itemEnd(code, fn.index)]);
  }
  return found;
}

/** Files that the out-of-line test-only `modules` declared in `file` point at. */
function testModuleFiles(file: string, modules: string[]): string[] {
  const dir = posix.dirname(file);
  const base = posix.basename(file, ".rs");
  const modDir = ["lib", "main", "mod"].includes(base) ? dir : posix.join(dir, base);
  return modules.flatMap((m) => [posix.join(modDir, `${m}.rs`), posix.join(modDir, m, "mod.rs")]);
}

/** Whether a path names a test or test-support file by convention (directory or file name). */
export function isTestPath(file: string): boolean {
  const segments = file.split("/");
  return segments.slice(0, -1).some((s) => TEST_DIRS.has(s)) || TEST_FILE.test(segments.at(-1)!);
}

/** Whether a crate (directory `node`, package `name`) exists to support tests: harnesses, e2e suites, test utils. */
export function isTestSupportCrate(node: NodeId, name: string): boolean {
  return [node, name].some((text) => {
    const words = text.toLowerCase().split(/[/_-]/);
    return words.some((w, i) => TEST_SUPPORT_SEGMENT.test(w) || (w === "test" && /^(utils|helpers)$/.test(words[i + 1] ?? "")) || (w === "load" && words[i + 1]?.startsWith("test")));
  });
}

export interface RustTestCode {
  /** Files that are test code as a whole. */
  testFiles: Set<string>;
  /** Test regions of the other files, as offsets. */
  regions: Map<string, [number, number][]>;
}

/** Classify the test code of Rust `sources` (path → original and stripped text) in `tree` (DESIGN "Test code"). */
export function rustTestCode(tree: Tree, sources: Map<string, { text: string; code: string }>): RustTestCode {
  const supportFiles = new Set(cratesOf(tree).crates.filter((c) => isTestSupportCrate(c.node, c.name)).flatMap((c) => c.files));
  const testFiles = new Set<string>();
  const regions = new Map<string, [number, number][]>();
  for (const [file, { text, code }] of sources) {
    const found = testRegions(code, text);
    if (found.wholeFile || isTestPath(file) || supportFiles.has(file)) testFiles.add(file);
    regions.set(file, found.regions);
    for (const module of testModuleFiles(file, found.modules)) testFiles.add(module);
  }
  for (const file of testFiles) regions.delete(file);
  return { testFiles, regions };
}

function fileKind(file: string, test: RustTestCode): FileKind {
  const segments = file.split("/");
  if (test.testFiles.has(file)) return "test";
  if (segments.includes("benches") || segments.includes("examples")) return "aux";
  return "src";
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (code.charCodeAt(k) === 10) line++;
  return line;
}

function analyzeFile(file: string, code: string, kind: FileKind, testRegions: [number, number][]): FileStats {
  const regions = kind === "test" ? [[0, code.length] as [number, number]] : testRegions;
  const mask = code.split("");
  let testCode = "";
  for (const [from, to] of regions) {
    testCode += code.slice(from, to) + "\n";
    for (let k = from; k < to; k++) if (mask[k] !== "\n") mask[k] = " ";
  }
  const nonTest = kind === "src" ? mask.join("") : "";
  const unwraps = ENTRY_POINT.test(file) ? [] : [...nonTest.matchAll(UNWRAP)].map((m) => m.index);
  return {
    file,
    kind,
    fns: nonTest.match(FN)?.length ?? 0,
    pubFns: [...nonTest.matchAll(PUB_FN)].map((m) => m[1]),
    branches: nonTest.match(BRANCH)?.length ?? 0,
    unwraps: unwraps.length,
    unwrapWeight: unwraps.reduce((sum, i) => sum + unwrapWeight(nonTest, i), 0),
    firstUnwrapLine: unwraps.length ? lineAt(nonTest, unwraps[0]) : undefined,
    tests: code.match(TEST_ATTR)?.length ?? 0,
    ignored: code.match(IGNORE_ATTR)?.length ?? 0,
    testCode,
  };
}

/** Non-empty lines of a TOML document grouped by `[section]` header ("" for the preamble). */
function tomlSections(text: string): { header: string; lines: string[] }[] {
  const sections: { header: string; lines: string[] }[] = [{ header: "", lines: [] }];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) sections.push({ header: header[1].trim(), lines: [] });
    else if (line) sections.at(-1)!.lines.push(line);
  }
  return sections;
}

function packageName(cargoToml: string): string | undefined {
  const pkg = tomlSections(cargoToml).find((s) => s.header === "package");
  if (!pkg) return undefined;
  for (const line of pkg.lines) {
    const m = /^name\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

const DEP_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/;
const WORKSPACE_DEP_TABLE = /^workspace\.dependencies(?:\.(.+))?$/;

interface DependencyEntry {
  key: string;
  renamedTo?: string;
  inherited: boolean;
}

/** Entries of every dependency table whose header matches `table` (group 1 = dotted-table dependency key). */
function dependencyEntries(cargoToml: string, table: RegExp): DependencyEntry[] {
  const entries: DependencyEntry[] = [];
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  const renamedTo = (text: string) => /\bpackage\s*=\s*["']([^"']+)/.exec(text)?.[1];
  const inherited = (text: string) => /\bworkspace\s*=\s*true\b/.test(text);
  for (const section of tomlSections(cargoToml)) {
    const header = table.exec(section.header);
    if (!header) continue;
    if (header[1] !== undefined) {
      const body = section.lines.join("\n");
      entries.push({ key: unquote(header[1]), renamedTo: renamedTo(body), inherited: inherited(body) });
      continue;
    }
    for (const line of section.lines) {
      const key = /^("[^"]+"|'[^']+'|[\w-]+)/.exec(line)?.[1];
      if (key) entries.push({ key: unquote(key), renamedTo: renamedTo(line), inherited: inherited(line) });
    }
  }
  return entries;
}

/** Dependency key → package name for renamed entries of the root `[workspace.dependencies]`. */
function workspaceRenames(rootCargoToml: string): Map<string, string> {
  const renames = new Map<string, string>();
  for (const e of dependencyEntries(rootCargoToml, WORKSPACE_DEP_TABLE)) if (e.renamedTo) renames.set(e.key, e.renamedTo);
  return renames;
}

/**
 * Package names a Cargo.toml depends on, honouring `package = "…"` renames, both local and
 * inherited (`workspace = true`) from the workspace's `renames`.
 */
export function dependencyNames(cargoToml: string, renames = new Map<string, string>()): Set<string> {
  return new Set(
    dependencyEntries(cargoToml, DEP_TABLE).map(
      (e) => e.renamedTo ?? (e.inherited ? renames.get(e.key) : undefined) ?? e.key,
    ),
  );
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function cratesOf(tree: Tree): { crates: Crate[]; crateOf: Map<NodeId, Crate> } {
  const crateOf = new Map<NodeId, Crate>();
  const crates: Crate[] = [];
  const visit = (id: NodeId, current: Crate | undefined) => {
    const node = tree.nodes[id];
    if (node.kind === "crate") {
      current = { node: id, name: node.name, files: [] };
      crates.push(current);
    }
    if (current) {
      crateOf.set(id, current);
      current.files.push(...node.files);
    }
    for (const child of node.children) visit(child, current);
  };
  for (const node of Object.values(tree.nodes)) if (node.parent === null) visit(node.id, undefined);
  return { crates, crateOf };
}

function rustOptions(ctx: CollectCtx): RustOptions {
  return (ctx.config.plugins.rust ?? {}) as RustOptions;
}

function clippyEnabled(ctx: CollectCtx): boolean {
  return rustOptions(ctx).clippy === true || process.env.TECHTREE_CLIPPY === "1";
}

function clippyArgs(ctx: CollectCtx): string[] {
  const args = rustOptions(ctx).clippyArgs ?? [];
  return typeof args === "string" ? args.split(/\s+/).filter(Boolean) : args;
}

function hashFiles(repoRoot: string, files: string[], seed: string): string {
  const h = createHash("sha256").update(seed);
  for (const file of [...files].sort()) h.update(file).update("\0").update(readText(join(repoRoot, file)) ?? "").update("\0");
  return h.digest("hex").slice(0, 32);
}

interface ClippyRun {
  diagnostics: Map<NodeId, Diagnostic[]>;
  linted: Set<NodeId>;
}

/** Parse `cargo clippy --message-format=json` output, attributing messages to crates via `manifest_path`. */
export function parseClippyOutput(stdout: string, repoRoot: string, tree: Tree): ClippyRun {
  const diagnostics = new Map<NodeId, Diagnostic[]>();
  const built = new Set<NodeId>();
  const failed = new Set<NodeId>();
  const seen = new Set<string>();
  const allFiles = new Set(treeFiles(tree));
  const roots = [repoRoot, realpathSync(repoRoot)];
  const toRepoPath = (abs: string) =>
    roots.map((root) => relative(root, abs).split("\\").join("/")).find((p) => !p.startsWith("..")) ?? abs;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.manifest_path !== "string") continue;
    const crateNode = nodeOfFile(toRepoPath(msg.manifest_path));
    if (tree.nodes[crateNode]?.kind !== "crate") continue;
    if (msg.reason === "compiler-artifact" && !msg.target?.kind?.includes("custom-build")) built.add(crateNode);
    if (msg.reason !== "compiler-message") continue;
    const m = msg.message;
    const code: string | undefined = m.code?.code;
    const isLint = code !== undefined && !/^E\d+$/.test(code);
    if (m.level === "error" && !isLint) failed.add(crateNode);
    if (!isLint || (m.level !== "warning" && m.level !== "error")) continue;
    const span = (m.spans ?? []).find((s: any) => s.is_primary) ?? m.spans?.[0];
    if (!span) continue;
    const abs = isAbsolute(span.file_name) ? span.file_name : resolve(repoRoot, span.file_name);
    let file = toRepoPath(abs);
    if (!allFiles.has(file)) file = posix.join(crateNode, span.file_name);
    if (!allFiles.has(file)) continue;
    const key = [file, span.byte_start, span.byte_end, code, m.message].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    const machineApplicable = (m.children ?? []).some((c: any) =>
      (c.spans ?? []).some((s: any) => s.suggestion_applicability === "MachineApplicable"),
    );
    const list = diagnostics.get(crateNode) ?? [];
    list.push({
      file,
      line: span.line_start,
      rule: code.replace(/^clippy::/, ""),
      message: m.message,
      error: m.level === "error",
      machineApplicable,
      snippet: (span.text?.[0]?.text ?? "").trim(),
    });
    diagnostics.set(crateNode, list);
  }
  const linted = new Set([...built, ...diagnostics.keys()].filter((n) => !failed.has(n)));
  return { diagnostics, linted };
}

async function runClippy(ctx: CollectCtx, crates: Crate[]): Promise<Map<NodeId, Diagnostic[]>> {
  const lints = new Map<NodeId, Diagnostic[]>();
  if (!clippyEnabled(ctx)) return lints;
  const excluded = new Set(rustOptions(ctx).exclude ?? []);
  const args = clippyArgs(ctx);
  const shared = ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"]
    .map((f) => readText(join(ctx.repoRoot, f)) ?? "")
    .concat(args)
    .join("\0");
  const stale: { crate: Crate; key: string }[] = [];
  for (const crate of crates) {
    if (excluded.has(crate.name)) continue;
    const key = `${crate.name}:${hashFiles(ctx.repoRoot, crate.files, shared)}`;
    const cached = ctx.cache.get<Diagnostic[]>("clippy", key);
    if (cached) lints.set(crate.node, cached);
    else stale.push({ crate, key });
  }
  if (stale.length === 0) return lints;
  const res = await run(
    "cargo",
    ["clippy", "--message-format=json", ...stale.flatMap((s) => ["-p", s.crate.name]), ...args],
    ctx.repoRoot,
    ctx.signal,
  );
  const result = parseClippyOutput(res.stdout, ctx.repoRoot, ctx.tree);
  for (const { crate, key } of stale) {
    if (!result.linted.has(crate.node)) {
      ctx.log(`rust: clippy produced no result for ${crate.name}; skipping lint_warnings (${res.stderr.trim().split("\n").at(-1) ?? ""})`);
      continue;
    }
    const diags = result.diagnostics.get(crate.node) ?? [];
    ctx.cache.set("clippy", key, diags);
    lints.set(crate.node, diags);
  }
  return lints;
}

function testTimes(repoRoot: string): Map<string, number> {
  const target = process.env.CARGO_TARGET_DIR ? resolve(repoRoot, process.env.CARGO_TARGET_DIR) : join(repoRoot, "target");
  const times = new Map<string, number>();
  let profiles: string[];
  try {
    profiles = readdirSync(join(target, "nextest"));
  } catch {
    return times;
  }
  for (const profile of profiles) {
    let entries: string[];
    try {
      entries = readdirSync(join(target, "nextest", profile)).filter((f) => f.endsWith(".xml"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const xml = readText(join(target, "nextest", profile, entry)) ?? "";
      for (const [suite] of xml.matchAll(/<testsuite\b[^>]*>/g)) {
        const name = /\bname="([^"]+)"/.exec(suite)?.[1];
        const time = Number(/\btime="([^"]+)"/.exec(suite)?.[1]);
        if (!name || !Number.isFinite(time)) continue;
        const pkg = name.split("::")[0];
        times.set(pkg, (times.get(pkg) ?? 0) + time);
      }
    }
  }
  return times;
}

async function analyze(ctx: CollectCtx): Promise<Analysis> {
  const sources = new Map<string, { text: string; code: string }>();
  for (const file of treeFiles(ctx.tree)) {
    if (!file.endsWith(".rs")) continue;
    const text = readSource(ctx.repoRoot, file);
    if (text !== undefined) sources.set(file, { text, code: stripRust(text) });
  }
  const test = rustTestCode(ctx.tree, sources);
  const files = [...sources].map(([file, { code }]) => analyzeFile(file, code, fileKind(file, test), test.regions.get(file) ?? []));
  const { crates, crateOf } = cratesOf(ctx.tree);
  return { files, crates, crateOf, lints: await runClippy(ctx, crates) };
}

const analyses = new WeakMap<CollectCtx, Promise<Analysis>>();

function analysisFor(ctx: CollectCtx): Promise<Analysis> {
  let analysis = analyses.get(ctx);
  if (!analysis) analyses.set(ctx, (analysis = analyze(ctx)));
  return analysis;
}

function fanIn(ctx: CollectCtx, crates: Crate[]): Map<string, number> {
  const counts = new Map<string, number>();
  const renames = workspaceRenames(readText(join(ctx.repoRoot, "Cargo.toml")) ?? "");
  for (const crate of crates) {
    const toml = readText(join(ctx.repoRoot, crate.node, "Cargo.toml")) ?? "";
    for (const dep of dependencyNames(toml, renames)) if (dep !== crate.name) counts.set(dep, (counts.get(dep) ?? 0) + 1);
  }
  return counts;
}

const LINT_TAGS: [RegExp, string][] = [
  [/lock|mutex|atomic|arc_|rc_|send|sync|await|thread/, "concurrency"],
  [/unsafe|transmute|ptr|uninit|mem_forget/, "security"],
  [/must_use|_doc|new_without_default|self_convention|pub_|exhaustive/, "api"],
];

function clippyFinding(d: Diagnostic, occurrence: number): Finding {
  const tags = LINT_TAGS.filter(([re]) => re.test(d.rule)).map(([, tag]) => tag);
  return {
    id: findingId("clippy", d.file, d.rule, occurrence ? `${d.snippet}#${occurrence}` : d.snippet),
    node: nodeOfFile(d.file),
    file: d.file,
    line: d.line,
    source: "clippy",
    title: `${d.rule}: ${d.message}`,
    detail: `${d.file}:${d.line}: ${d.message}${d.snippet ? `\n\n    ${d.snippet}` : ""}`,
    severity: d.error ? "high" : "low",
    effort: d.machineApplicable ? "trivial" : "small",
    metricEffects: { lint_warnings: -1 },
    ...(tags.length ? { tags } : {}),
  };
}

function scaledEffort(n: number, trivialUpTo: number, smallUpTo: number): Effort {
  return n <= trivialUpTo ? "trivial" : n <= smallUpTo ? "small" : "medium";
}

export const rustPlugin: MetricPlugin = {
  id: "rust",
  metrics: [
    { key: "fn_count", label: "Functions", direction: "neutral", aggregate: "sum" },
    { key: "pub_fn_count", label: "Public functions", direction: "neutral", aggregate: "sum" },
    { key: "complexity", label: "Branches per fn", direction: "lower_better", aggregate: "sum", normalizeBy: "fn_count" },
    { key: "unwrap_density", label: "unwrap/expect density", unit: "per kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
    { key: "test_count", label: "Tests", direction: "neutral", aggregate: "sum" },
    { key: "test_ratio", label: "Tests per public fn", direction: "higher_better", aggregate: "sum", normalizeBy: "pub_fn_count" },
    { key: "ignored_tests", label: "Ignored tests", direction: "lower_better", aggregate: "sum" },
    { key: "fan_in", label: "Dependent crates", direction: "neutral", aggregate: "max" },
    { key: "lint_warnings", label: "Lint warnings", unit: "per kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
    { key: "test_time", label: "Test time", unit: "s", direction: "neutral", aggregate: "sum" },
  ],

  annotate(tree) {
    for (const node of Object.values(tree.nodes)) {
      if (!node.files.includes(posix.join(node.id, "Cargo.toml"))) continue;
      const name = packageName(readText(join(tree.repoRoot, node.id, "Cargo.toml")) ?? "");
      if (name === undefined) continue;
      node.kind = "crate";
      node.name = name;
    }
  },

  async collect(ctx) {
    const { files, crates, crateOf, lints } = await analysisFor(ctx);
    const values: MetricValues = {};
    const own = (node: NodeId) => (values[node] ??= {});
    for (const f of files) {
      const v = own(nodeOfFile(f.file));
      const add = (key: string, n: number) => (v[key] = (v[key] ?? 0) + n);
      add("fn_count", f.fns);
      add("pub_fn_count", f.pubFns.length);
      add("complexity", f.branches);
      add("unwrap_density", f.unwraps);
      add("test_count", f.tests);
      add("test_ratio", f.tests);
      add("ignored_tests", f.ignored);
    }
    for (const node of Object.keys(values)) {
      const crate = crateOf.get(node);
      if (crate && lints.has(crate.node)) values[node].lint_warnings = 0;
    }
    for (const d of [...lints.values()].flat()) {
      const v = own(nodeOfFile(d.file));
      v.lint_warnings = (v.lint_warnings ?? 0) + 1;
    }
    const dependents = fanIn(ctx, crates);
    const times = testTimes(ctx.repoRoot);
    for (const crate of crates) {
      own(crate.node).fan_in = dependents.get(crate.name) ?? 0;
      const time = times.get(crate.name) ?? times.get(crate.name.replace(/-/g, "_"));
      if (time !== undefined) own(crate.node).test_time = time;
    }
    return values;
  },

  async findings(ctx) {
    const { files, crates, crateOf, lints } = await analysisFor(ctx);
    const findings: Finding[] = [];
    for (const diags of lints.values()) {
      const occurrences = new Map<string, number>();
      for (const d of diags) {
        const key = [d.file, d.rule, d.snippet].join("\0");
        const n = occurrences.get(key) ?? 0;
        occurrences.set(key, n + 1);
        findings.push(clippyFinding(d, n));
      }
    }
    const dependents = fanIn(ctx, crates);
    const testIdents = new Map<NodeId, Set<string>>(crates.map((c) => [c.node, new Set<string>()]));
    for (const f of files) {
      const idents = testIdents.get(crateOf.get(nodeOfFile(f.file))?.node ?? "\0");
      if (idents) for (const [id] of f.testCode.matchAll(IDENT)) idents.add(id);
    }
    for (const f of files) {
      const node = nodeOfFile(f.file);
      if (f.unwraps > 0) {
        findings.push({
          id: findingId("unwrap", f.file, "unwrap-expect", ""),
          node,
          file: f.file,
          line: f.firstUnwrapLine,
          source: "unwrap",
          title: `Replace ${f.unwraps} unwrap/expect call${f.unwraps === 1 ? "" : "s"} in ${f.file}`,
          detail: `${f.file} calls .unwrap() or .expect( ${f.unwraps} time(s) outside test code; each is a potential panic. Propagate or handle the error instead.`,
          severity: f.unwraps >= 5 ? "medium" : "low",
          effort: scaledEffort(f.unwraps, 2, 10),
          metricEffects: { unwrap_density: -f.unwraps },
          confidence: f.unwrapWeight / f.unwraps,
        });
      }
      const crate = crateOf.get(node);
      const idents = testIdents.get(crate?.node ?? "\0");
      if (!idents || !dependents.get(crate!.name)) continue;
      const untested = [...new Set(f.pubFns)].filter((name) => !idents.has(name));
      if (untested.length === 0) continue;
      findings.push({
        id: findingId("test-gap", f.file, "untested-pub-fn", ""),
        node,
        file: f.file,
        source: "test-gap",
        title: `Test ${untested.length} public fn${untested.length === 1 ? "" : "s"} in ${f.file}`,
        detail: `No test in the crate mentions: ${untested.join(", ")}.`,
        severity: "low",
        effort: untested.length <= 3 ? "small" : "medium",
        metricEffects: { test_count: untested.length, test_ratio: untested.length },
        tags: ["api"],
        confidence: 0.3,
      });
    }
    return findings;
  },
};
