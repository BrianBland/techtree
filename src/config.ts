import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

export const DEFAULT_WEIGHTS: Record<string, number> = {
  test_ratio: 3,
  lint_warnings: 2,
  unwrap_density: 2,
  complexity: 2,
  ignored_tests: 1,
  todo_density: 1,
  max_file_loc: 1,
  review_debt: 3,
};

export const DEFAULT_CONFIG: Config = {
  weights: DEFAULT_WEIGHTS,
  minLoc: 200,
  workers: 3,
  worktreeTemplate: "{home}/code/worktrees/{repo}/techtree-{task}",
  baseRef: "HEAD",
  piCommand: process.env.TECHTREE_PI ? process.env.TECHTREE_PI.split(" ") : ["pi"],
  ignore: ["target", "node_modules", ".git"],
  plugins: {},
};

/** Load `.techtree.yaml` from the repo root and merge it over the defaults. */
export function loadConfig(repoRoot: string): Config {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, ".techtree.yaml"), "utf8");
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  return mergeConfig(parseYaml(text) as Partial<Config>);
}

export function mergeConfig(user: Partial<Config>): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    ...base,
    ...user,
    weights: { ...base.weights, ...(user.weights ?? {}) },
    plugins: { ...base.plugins, ...(user.plugins ?? {}) },
  };
}

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

/**
 * Parse the YAML subset techtree config uses: nested block mappings, block
 * sequences of scalars, flow sequences (`[a, b]`), scalars and `#` comments.
 * Anchors, multi-line strings and flow mappings are not supported.
 */
export function parseYaml(text: string): Yaml {
  const lines = text
    .split("\n")
    .map((raw) => raw.replace(/\s+#.*$|^\s*#.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "");
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;

  function block(indent: number): Yaml {
    if (i < lines.length && lines[i].trimStart().startsWith("- ")) {
      const list: Yaml[] = [];
      while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith("- ")) {
        list.push(scalar(lines[i].trimStart().slice(2)));
        i++;
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (i < lines.length && indentOf(lines[i]) === indent) {
      const line = lines[i].trim();
      const colon = line.indexOf(":");
      if (colon < 0) throw new Error(`.techtree.yaml: expected "key: value" at "${line}"`);
      const key = unquote(line.slice(0, colon).trim());
      const rest = line.slice(colon + 1).trim();
      i++;
      if (rest !== "") map[key] = scalar(rest);
      else if (i < lines.length && indentOf(lines[i]) > indent) map[key] = block(indentOf(lines[i]));
      else map[key] = null;
    }
    return map;
  }
  return lines.length ? block(indentOf(lines[0])) : {};
}

function unquote(s: string): string {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function scalar(s: string): Yaml {
  s = s.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map(scalar) : [];
  }
  if (/^(["']).*\1$/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
