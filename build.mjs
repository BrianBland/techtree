import { randomUUID } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
  }),
  build({
    ...common,
    entryPoints: ["src/web/main.tsx"],
    outfile: "dist/web/app.js",
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: !watch,
  }),
]);

for (const file of ["index.html", "style.css"]) copyFileSync(`src/web/${file}`, `dist/web/${file}`);
// Written last: running servers hand over to a new build once its id appears (DESIGN "Server lifecycle").
writeFileSync("dist/build-id", `${randomUUID()}\n`);
