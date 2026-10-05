import type { CollectCtx, Effort, Finding, MetricPlugin, MetricValues, NodeId } from "../types.ts";
import { lexRust, matchingBrace, TEST_ATTR } from "./rust.ts";
import { findingId, nodeOfFile, readSource, treeFiles } from "./util/source.ts";

const CODE_FILE = /\.(rs|ts|tsx|js|jsx|mjs|cjs|go|java|kt|swift|c|h|cc|cpp|hpp|cs|scala|sol)$/;

interface SourceFile {
  file: string;
  text: string;
  /** `text` with comments and literal contents blanked (see `lexRust`). */
  code: string;
  comments: [number, number][];
  /** 1-based line of an offset. */
  lineOf(offset: number): number;
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const WINDOW = 10;
const MIN_WINDOW_CHARS = 250;
const MIN_TEST_BLOCK = 20;
const TEST_PATH = /(^|\/)(tests?|__tests__|test_utils|testing)\/|[._](test|spec)s?\.\w+$|(^|\/)(tests?|test_utils|testing)\.rs$/;
const NOT_SIGNIFICANT = /^(?:(?:pub(?:\([^)]*\))?\s+)?(?:use\s|mod\s+\w+\s*;)|import\s|extern\s+crate\s|package\s|#!?\[)/;

interface SignificantLine {
  line: number;
  text: string;
}

interface Block {
  file: string;
  lines: SignificantLine[];
  others: { file: string; line: number }[];
  inTest: boolean;
}

interface DupInput {
  file: string;
  lines: SignificantLine[];
  /** First line of test code (Infinity when none). */
  testFrom: number;
}

/** The file text with comments blanked (newlines kept) but literals intact, so different data never matches. */
function withoutComments({ text, comments }: SourceFile): string {
  let out = "";
  let at = 0;
  for (const [start, end] of comments) {
    out += text.slice(at, start) + text.slice(start, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return out + text.slice(at);
}

function significantLines(code: string): SignificantLine[] {
  const out: SignificantLine[] = [];
  code.split("\n").forEach((raw, i) => {
    const trimmed = raw.trim();
    if (/[A-Za-z0-9]/.test(trimmed) && !NOT_SIGNIFICANT.test(trimmed)) out.push({ line: i + 1, text: trimmed.replace(/\s+/g, "") });
  });
  return out;
}

/** Duplicated blocks and, per file, the significant lines covered by a matching window (DESIGN "Duplication"). */
function findDuplicates(files: DupInput[]): { blocks: Block[]; dupLines: number[] } {
  const ids = new Map<string, number>();
  const keys = files.map(({ lines }) => {
    const seq = lines.map((l) => ids.get(l.text) ?? ids.set(l.text, ids.size).size - 1);
    return Array.from({ length: Math.max(0, seq.length - WINDOW + 1) }, (_, p) => {
      const window = seq.slice(p, p + WINDOW);
      const chars = lines.slice(p, p + WINDOW).reduce((sum, l) => sum + l.text.length, 0);
      return new Set(window).size < WINDOW / 2 || chars < MIN_WINDOW_CHARS ? undefined : window.join(",");
    });
  });
  const occurrences = new Map<string, [number, number][]>();
  keys.forEach((ks, f) =>
    ks.forEach((k, p) => {
      if (k === undefined) return;
      const list = occurrences.get(k);
      if (list) list.push([f, p]);
      else occurrences.set(k, [[f, p]]);
    }),
  );
  const partners = (f: number, p: number): [number, number][] => {
    const list = keys[f][p] === undefined ? undefined : occurrences.get(keys[f][p]!)!;
    if (!list || list.length < 2) return [];
    return list.filter(([g, q]) => g !== f || Math.abs(q - p) >= WINDOW);
  };

  const dupLines = files.map(({ lines }, f) => {
    const covered = new Uint8Array(lines.length);
    for (let p = 0; p < keys[f].length; p++) if (partners(f, p).length) covered.fill(1, p, p + WINDOW);
    return covered.reduce((sum, c) => sum + c, 0);
  });

  const started = keys.map((ks) => new Uint8Array(ks.length));
  const blocks: Block[] = [];
  files.forEach(({ file, lines, testFrom }, f) => {
    for (let p = 0; p < keys[f].length; p++) {
      if (started[f][p]) continue;
      const others = partners(f, p);
      if (!others.length) continue;
      const [g, q] = others[0];
      let len = 1;
      while (p + len < keys[f].length && keys[f][p + len] !== undefined && keys[f][p + len] === keys[g][q + len]) len++;
      for (let k = 0; k < len; k++) for (const [h, r] of occurrences.get(keys[f][p + k]!)!) started[h][r] = 1;
      blocks.push({
        file,
        lines: lines.slice(p, p + len + WINDOW - 1),
        others: others.map(([h, r]) => ({ file: files[h].file, line: files[h].lines[r].line })),
        inTest: lines[p].line >= testFrom,
      });
    }
  });
  return { blocks, dupLines };
}

function duplicationFinding(block: Block): Finding {
  const n = block.lines.length;
  const copies = block.others.length + 1;
  const where = block.others.map((o) => `${o.file}:${o.line}`);
  const more = block.others.length > 1 ? `, +${block.others.length - 1} more` : "";
  return {
    id: findingId("duplication", block.file, "duplicate-block", block.lines.map((l) => l.text).join("\n")),
    node: nodeOfFile(block.file),
    file: block.file,
    line: block.lines[0].line,
    source: "duplication",
    title: `Deduplicate ${n}-line block in ${block.file} (also in ${block.others[0].file}${more})`,
    detail: `${n} significant lines starting at ${block.file}:${block.lines[0].line} also appear at ${where.slice(0, 5).join(", ")}${where.length > 5 ? ` and ${where.length - 5} more places` : ""}. Extract the shared code into one function or module.`,
    severity: n >= 30 || copies >= 3 ? "medium" : "low",
    effort: n < 30 ? "small" : n < 100 ? "medium" : "large",
    metricEffects: { dup_lines: -n },
    confidence: 0.9,
  };
}

type NoiseKind = "divider" | "commented-out code" | "stale note" | "restating";

const NOISE_WEIGHT: Record<NoiseKind, number> = { divider: 0.9, "commented-out code": 0.8, "stale note": 0.7, restating: 0.6 };
const KEEP = /SAFETY:|\b(?:TODO|FIXME|XXX|HACK)\b|eslint|@ts-|prettier|rustfmt|clippy::|noqa|nolint/;
const LICENSE = /licen[sc]e|copyright|spdx/i;
const DIVIDER_RUNS = /([-=*#~_/+])\1{3,}/g;
const CODE_END = /[;{}),]$/;
const CODE_SHAPE = /\w\(|[^=!<>]=[^=>]|::|->|=>|^[{}()[\];,\s]+$/;
const KEYWORDS = new Set("let mut fn pub use return if else for in match impl struct enum const static await async as ref move where dyn self type".split(" "));
const STALE = /^(?:removed|old|unused|deprecated|dead code|no longer used)\b/i;
const STATEMENT_END = /[;{}]$/;
const INTENT = /\?|\b(?:because|why|note|so|otherwise|ensure|since|unless|must|never|always|only|not|until|workaround)\b/i;
const STOPWORDS = new Set("the a an of to and or for in on with from this that it is be by as at we our its into then now all are".split(" "));
const SYNONYM: Record<string, string> = {
  create: "new", construct: "new", build: "new", init: "new", initialize: "new",
  fetch: "get", read: "get", retrieve: "get",
  update: "set", assign: "set",
  length: "len", count: "len",
  error: "err",
  iterate: "iter", loop: "iter", each: "iter",
};

interface CommentLine {
  line: number;
  text: string;
}

interface NoiseLine {
  line: number;
  kind: NoiseKind;
}

const isDoc = (comment: string) => /^\/\/[/!](?!\/)|^\/\*[*!](?!\/)/.test(comment);

/** Comment lines that stand on their own line, outside doc comments, with their text (markers removed). */
function ownLineComments(src: SourceFile): CommentLine[] {
  const codeLines = src.code.split("\n");
  const out: CommentLine[] = [];
  for (const [start, end] of src.comments) {
    const comment = src.text.slice(start, end);
    if (isDoc(comment)) continue;
    const first = src.lineOf(start) - 1;
    comment.split("\n").forEach((raw, k) => {
      const index = first + k;
      if (codeLines[index].trim() !== "") return;
      const text = raw.replace(/^\s*(?:\/\/|\/\*+|\*+(?!\/))/, "").replace(/\*+\/\s*$/, "").trim();
      out.push({ line: index + 1, text });
    });
  }
  return out;
}

function identifierParts(code: string): Set<string> {
  const parts = new Set<string>();
  for (const [id] of code.matchAll(/[A-Za-z_]\w*/g)) {
    for (const part of id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_")) if (part) parts.add(singular(part));
  }
  return parts;
}

const singular = (word: string) => (word.length > 3 ? word.replace(/s$/, "") : word);

function restates(text: string, nextCode: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < 2 || words.length > 6 || INTENT.test(text)) return false;
  const content = words.filter((w) => !STOPWORDS.has(w)).map(singular);
  const parts = identifierParts(nextCode);
  return content.length >= 2 && content.every((w) => parts.has(w) || parts.has(SYNONYM[w]));
}

/** Backticks, or three plain words in a row that are not keywords, mark a sentence rather than code. */
function isProse(text: string): boolean {
  if (text.includes("`")) return true;
  let plain = 0;
  for (const token of text.split(/\s+/)) {
    plain = /^[A-Za-z]+[,.]?$/.test(token) && !KEYWORDS.has(token) ? plain + 1 : 0;
    if (plain >= 3) return true;
  }
  return false;
}

function isDivider(text: string): boolean {
  const rest = text.replace(DIVIDER_RUNS, "");
  return rest !== text && rest.trim().length <= 40;
}

/** Noise comment lines of a file (DESIGN "Comment noise"). */
function noiseLines(src: SourceFile): NoiseLine[] {
  const comments = ownLineComments(src);
  const codeLines = src.code.split("\n");
  const firstCode = codeLines.findIndex((l) => l.trim() !== "") + 1 || Infinity;
  const runs: CommentLine[][] = [];
  for (const c of comments) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.line === c.line - 1) run.push(c);
    else runs.push([c]);
  }
  const noise: NoiseLine[] = [];
  for (const run of runs) {
    if (run[0].line < firstCode && run.some((c) => LICENSE.test(c.text))) continue;
    const codeLike = run.map((c) => CODE_END.test(c.text) && CODE_SHAPE.test(c.text) && !isProse(c.text));
    const table = run.some((c) => c.text.includes("|"));
    const divider = run.map((c) => !table && isDivider(c.text));
    const hasStatement = run.some((c, i) => codeLike[i] && STATEMENT_END.test(c.text));
    run.forEach((c, i) => {
      if (KEEP.test(c.text)) return;
      const kind: NoiseKind | undefined =
        divider[i] || (divider[i - 1] && divider[i + 1])
          ? "divider"
          : codeLike[i] && hasStatement
            ? "commented-out code"
            : run.length === 1 && STALE.test(c.text) && c.text.split(/\s+/).length <= 3
              ? "stale note"
              : run.length === 1 && restates(c.text, codeLines[c.line] ?? "")
                ? "restating"
                : undefined;
      if (kind) noise.push({ line: c.line, kind });
    });
  }
  return noise;
}

function noiseFinding(file: string, noise: NoiseLine[]): Finding {
  const n = noise.length;
  const listed = noise.slice(0, 20).map((l) => `${file}:${l.line} (${l.kind})`);
  return {
    id: findingId("comment-noise", file, "noise-comments", ""),
    node: nodeOfFile(file),
    file,
    line: noise[0].line,
    source: "comment-noise",
    title: `Remove ${n} noise comment line${n === 1 ? "" : "s"} in ${file}`,
    detail: `Comments that add nothing the code does not say: ${listed.join(", ")}${n > 20 ? `, and ${n - 20} more` : ""}. Delete them, or rename and restructure the code so it explains itself.`,
    severity: "low",
    effort: n <= 5 ? "trivial" : n <= 30 ? "small" : "medium",
    metricEffects: { comment_noise: -n },
    confidence: noise.reduce((sum, l) => sum + NOISE_WEIGHT[l.kind], 0) / n,
  };
}

type SmellRule = "assert-free" | "duplicate-tests" | "trivial-assert" | "long-test";

const SMELL_WEIGHT: Record<SmellRule, number> = { "assert-free": 0.7, "duplicate-tests": 0.8, "trivial-assert": 0.9, "long-test": 0.5 };
const LONG_TEST = 120;
const LONG_TEST_STATEMENTS = 40;
const MIN_DUPLICATE_BODY = 40;
const EXPECTATION = /assert|expect|\b(?:panic|unreachable|todo)!|\.unwrap\w*\(|\.times\(|\b(?:check|verify|ensure|validate)\w*\s*(?:::<[^>]*>)?\(/i;
const NON_ASSERTING_MACROS = new Set(["println", "print", "eprintln", "eprint", "dbg", "format", "vec", "matches", "write", "writeln"]);
const LITERAL = /^(?:-?\d[\w.]*|b?""|b?''|true|false)$/;

interface FnBody {
  start: number;
  name: string;
  line: number;
  header: string;
  body: string;
}

interface Smell {
  rule: SmellRule;
  tests: string[];
  line: number;
  count: number;
}

function fnBodies({ code, lineOf }: SourceFile): FnBody[] {
  const fns: FnBody[] = [];
  const bodyOrDecl = /[{;]/g;
  for (const m of code.matchAll(/\bfn\s+([A-Za-z_]\w*)|\bmacro_rules!\s*([A-Za-z_]\w*)/g)) {
    bodyOrDecl.lastIndex = m.index;
    const open = bodyOrDecl.exec(code)?.index ?? -1;
    if (code[open] !== "{") continue;
    const name = m[1] ?? `${m[2]}!`;
    fns.push({ start: m.index, name, line: lineOf(m.index), header: code.slice(m.index, open), body: code.slice(open, matchingBrace(code, open)) });
  }
  return fns;
}

function hasExpectation(body: string): boolean {
  if (EXPECTATION.test(body)) return true;
  for (const [, name] of body.matchAll(/\b([A-Za-z_]\w*)!\s*[([{]/g)) if (!NON_ASSERTING_MACROS.has(name)) return true;
  return false;
}

/** Names of local fns and macros that check something, directly or through another one they mention. */
function expectingFns(fns: FnBody[]): Set<string> {
  const references = new Map(fns.map((f) => [f.name, new Set(f.body.match(/\b[A-Za-z_]\w*!?/g))]));
  const expecting = new Set(fns.filter((f) => hasExpectation(f.body)).map((f) => f.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of fns) {
      if (!expecting.has(f.name) && [...references.get(f.name)!].some((r) => expecting.has(r))) (expecting.add(f.name), (grew = true));
    }
  }
  return expecting;
}

/** Operands of the macro call whose `(` is at `open`, split at top-level commas, whitespace removed. */
function macroArgs(code: string, open: number): string[] {
  const args = [""];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if ("([{".includes(c) && depth++ === 0) continue;
    if (")]}".includes(c) && --depth === 0) break;
    if (c === "," && depth === 1) args.push("");
    else if (!/\s/.test(c)) args[args.length - 1] += c;
  }
  return args;
}

function trivialAsserts(body: string): number {
  let n = body.match(/\bassert!\s*\(\s*(?:true|!\s*false)\s*\)/g)?.length ?? 0;
  for (const m of body.matchAll(/\bassert_(?:eq|ne)!\s*\(/g)) {
    const [a, b] = macroArgs(body, m.index + m[0].length - 1);
    if (b !== undefined && ((a === b && !a.includes("(")) || (LITERAL.test(a) && LITERAL.test(b)))) n++;
  }
  return n;
}

/** Test smells of a Rust file (DESIGN "Test smells"). */
function testSmells(src: SourceFile): Smell[] {
  const { code } = src;
  const fns = fnBodies(src);
  const byStart = new Map(fns.map((f) => [f.start, f]));
  const tests = new Map<number, FnBody & { attrs: string }>();
  const nextFn = /\bfn\s+[A-Za-z_]\w*/g;
  for (const m of code.matchAll(TEST_ATTR)) {
    nextFn.lastIndex = m.index;
    const found = nextFn.exec(code);
    const fn = found && byStart.get(found.index);
    if (fn && !tests.has(fn.start)) tests.set(fn.start, { ...fn, attrs: code.slice(m.index, fn.start) });
  }
  if (tests.size === 0) return [];
  const expecting = expectingFns(fns);
  const smells: Smell[] = [];
  const add = (rule: SmellRule, flagged: FnBody[], count = flagged.length) => {
    if (flagged.length) smells.push({ rule, tests: flagged.map((t) => t.name), line: flagged[0].line, count });
  };

  add(
    "assert-free",
    [...tests.values()].filter((t) => {
      if (t.attrs.includes("should_panic") || expecting.has(t.name)) return false;
      return !(/->[^{]*Result/.test(t.header) && t.body.includes("?"));
    }),
  );
  const groups = new Map<string, FnBody[]>();
  for (const t of tests.values()) {
    if (t.attrs.includes("#[case")) continue;
    const shape = t.body.replace(/\b\d[\w.]*/g, "0").replace(/\s+/g, "");
    if (shape.length < MIN_DUPLICATE_BODY) continue;
    groups.set(shape, [...(groups.get(shape) ?? []), t]);
  }
  for (const group of groups.values()) if (group.length > 1) add("duplicate-tests", group);
  const trivial = [...tests.values()].map((t) => ({ t, n: trivialAsserts(t.body) })).filter((x) => x.n > 0);
  add("trivial-assert", trivial.map((x) => x.t), trivial.reduce((sum, x) => sum + x.n, 0));
  add("long-test", [...tests.values()].filter((t) => t.body.split("\n").filter((l) => l.trim()).length > LONG_TEST && (t.body.match(/;/g)?.length ?? 0) > LONG_TEST_STATEMENTS));
  return smells;
}

function smellFinding(file: string, smell: Smell): Finding {
  const n = smell.count;
  const s = n === 1 ? "" : "s";
  const title = {
    "assert-free": `${n} test${s} in ${file} assert${n === 1 ? "s" : ""} nothing`,
    "duplicate-tests": `Merge ${n} near-duplicate tests in ${file}`,
    "trivial-assert": `Remove ${n} trivial assert${s} in ${file}`,
    "long-test": `Split ${n} overlong test${s} in ${file}`,
  }[smell.rule];
  const why = {
    "assert-free": "check nothing: they pass unless they panic, so they guard no behavior. Assert on the result, or delete them",
    "duplicate-tests": "have the same body up to literal values. Merge them into one table-driven test",
    "trivial-assert": "contain asserts that cannot fail (constant or identical operands). Assert on real results, or remove them",
    "long-test": `are longer than ${LONG_TEST} lines and ${LONG_TEST_STATEMENTS} statements. Split them by behavior and extract shared setup`,
  }[smell.rule];
  return {
    id: findingId("test-smell", file, smell.rule, smell.rule === "duplicate-tests" ? smell.tests[0] : ""),
    node: nodeOfFile(file),
    file,
    line: smell.line,
    source: "test-smell",
    title,
    detail: `Tests ${smell.tests.join(", ")} in ${file} ${why}.`,
    severity: "low",
    effort: smell.rule === "trivial-assert" ? "trivial" : smellEffort(smell.tests.length),
    metricEffects: { test_smells: -n },
    confidence: SMELL_WEIGHT[smell.rule],
  };
}

const smellEffort = (tests: number): Effort => (tests <= 3 ? "small" : "medium");

interface FileResult {
  file: string;
  dupLines: number;
  noise: NoiseLine[];
  smells: Smell[];
}

interface Analysis {
  files: FileResult[];
  blocks: Block[];
}

function testFrom(src: SourceFile): number {
  if (TEST_PATH.test(src.file)) return 1;
  const cfgTest = src.file.endsWith(".rs") ? src.code.indexOf("#[cfg(test)]") : -1;
  return cfgTest < 0 ? Infinity : src.lineOf(cfgTest);
}

function analyze(ctx: CollectCtx): Analysis {
  const sources: SourceFile[] = [];
  for (const file of treeFiles(ctx.tree).filter((f) => CODE_FILE.test(f)).sort()) {
    const text = readSource(ctx.repoRoot, file);
    if (text !== undefined) sources.push({ file, text, ...lexRust(text), lineOf: lineIndex(text) });
  }
  const { blocks, dupLines } = findDuplicates(sources.map((s) => ({ file: s.file, lines: significantLines(withoutComments(s)), testFrom: testFrom(s) })));
  const files = sources.map((src, i) => ({
    file: src.file,
    dupLines: dupLines[i],
    noise: noiseLines(src),
    smells: src.file.endsWith(".rs") ? testSmells(src) : [],
  }));
  return { files, blocks };
}

const analyses = new WeakMap<CollectCtx, Analysis>();

function analysisFor(ctx: CollectCtx): Analysis {
  let analysis = analyses.get(ctx);
  if (!analysis) analyses.set(ctx, (analysis = analyze(ctx)));
  return analysis;
}

export const slopPlugin: MetricPlugin = {
  id: "slop",
  metrics: [
    { key: "dup_lines", label: "Duplicated lines", unit: "per kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
    { key: "comment_noise", label: "Noise comments", unit: "per kLOC", direction: "lower_better", aggregate: "sum", normalizeBy: "loc" },
    { key: "test_smells", label: "Test smells per test", direction: "lower_better", aggregate: "sum", normalizeBy: "test_count" },
  ],

  async collect(ctx) {
    const values: MetricValues = {};
    for (const f of analysisFor(ctx).files) {
      const v = (values[nodeOfFile(f.file) as NodeId] ??= { dup_lines: 0, comment_noise: 0, test_smells: 0 });
      v.dup_lines += f.dupLines;
      v.comment_noise += f.noise.length;
      v.test_smells += f.smells.reduce((sum, s) => sum + s.count, 0);
    }
    return values;
  },

  async findings(ctx) {
    const { files, blocks } = analysisFor(ctx);
    return [
      ...blocks.filter((b) => !b.inTest || b.lines.length >= MIN_TEST_BLOCK).map(duplicationFinding),
      ...files.filter((f) => f.noise.length).map((f) => noiseFinding(f.file, f.noise)),
      ...files.flatMap((f) => f.smells.map((s) => smellFinding(f.file, s))),
    ];
  },
};
