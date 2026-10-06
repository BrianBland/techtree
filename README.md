# techtree

A [pi](https://github.com/earendil-works/pi) package that shows a repository as an RPG-style tech tree: every directory is a node scored for quality, with live agent tasks and PRs overlaid. From the tree you can start improvement tasks, each run by a headless pi worker in its own git worktree. Nothing is ever merged automatically.

The spec is [docs/DESIGN.md](docs/DESIGN.md).

## Install

```sh
npm install
npm run build        # dist/cli.js and the web UI in dist/web
pi install /path/to/techtree
```

## Use

In a pi session inside a git repository:

- `/techtree` starts (or reuses) the repository's techtree server, prints its URL and opens it in your default browser (`openBrowser: false` in the user config turns that off). A status widget shows running tasks and items that need attention. `/techtree url` only prints the URL; `/techtree stop` and `/techtree restart` stop or restart the server. After `npm run build` a running server restarts itself on the new build, keeping its URL, and open pages reload.
- `/techtree update` pulls the installed techtree checkout's current upstream branch (`git pull --ff-only`), rebuilds it, and restarts this repo's server on the same URL. It requires a clean Git checkout and installed build dependencies (`npm install`); it never updates the repo being scored, switches branches, or discards edits. Restart alone does not pull or rebuild. If the build fails, fix it before restarting.
- The `techtree_status` and `techtree_findings` tools let the agent read scores and findings.

The server is shared by every pi session in the repository and outlives them, so tasks keep running; it exits after two idle hours.

From a shell:

```sh
node dist/cli.js score [repo] [--project id]   # score headlessly and print a summary
node dist/cli.js serve [repo] [--port N]   # run the server in the foreground
node dist/cli.js stop [repo]    # stop it
```

State lives in `~/.cache/techtree/<repo-id>/` (SQLite, task logs, `server.json`, `server.log`). Optional settings go in `.techtree.yaml` at the repository root.

## Develop

```sh
npm run typecheck
npm test
npm run build && node dist/cli.js serve . --port 4321   # UI dev loop: rebuild, then reload the page
```
