// Stand-in for `gh`, invoked as `node fake-gh.mjs <dir> <gh args...>`. Canned output lives in <dir>:
// `user` (login for `gh api user`), `list.json` (`gh pr list`), `view-<n>.json` (`gh pr view <n>`).
// A `fail` file makes every call exit 1 with its contents on stderr. Each call is appended to `calls`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...args] = process.argv.slice(2);
appendFileSync(join(dir, "calls"), args.join(" ") + "\n");

const fail = (msg) => {
  process.stderr.write(msg);
  process.exit(1);
};
const cat = (name) => (existsSync(join(dir, name)) ? process.stdout.write(readFileSync(join(dir, name))) : fail(`no ${name}\n`));

if (existsSync(join(dir, "fail"))) fail(readFileSync(join(dir, "fail"), "utf8"));
else if (args[0] === "api" && args[1] === "user") cat("user");
else if (args[0] === "pr" && args[1] === "list") cat("list.json");
else if (args[0] === "pr" && args[1] === "view") cat(`view-${args[2]}.json`);
else fail(`unknown command: ${args.join(" ")}\n`);
