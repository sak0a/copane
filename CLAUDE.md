# Copane (VS Code extension)

Gives Claude Code and other MCP agents the VS Code window they run in: its integrated browser tabs
and integrated terminals, shared with the user, per window and per agent session.
Read `docs/ARCHITECTURE.md` before changing anything; `docs/feasibility-assessment.md` has the verified
facts about the VS Code APIs this builds on.

## Commands

    npm run check                                   # typecheck + unit tests + build (must pass before you finish)
    node scripts/dev-host.mjs --name <n>            # isolated VS Code with the extension loaded (builds first)
    node scripts/dev-host.mjs --name <n> --stop
    node scripts/mcp-call.mjs --name <n> --list     # talk to it through the real MCP server
    node scripts/mcp-call.mjs --name <n> --session s1 <tool> '<json>'
    node scripts/mcp-call.mjs --name <n> --session s1 --repl < calls.txt

    node scripts/ui.mjs --name <n> shot|text|eval   # look at the dev host's UI (screenshot, DOM) without touching the desktop
    node test/e2e/<module>.e2e.mjs --name <n>       # end-to-end cases against a running dev host
    node scripts/e2e.mjs [suite...] [--vscode insiders]  # suites on fresh dev hosts, as CI runs them

    node scripts/remote-dev-host.mjs --name <n>     # a real remote window: the extension in a Docker container (needs Docker)
    docker exec copane-remote-<n> node /copane/test/e2e/remote.e2e.mjs --name <n>   # e2e inside it (any suite works)
    node scripts/remote-dev-host.mjs --name <n> --stop --rm
    node scripts/perf-terminals.mjs --name <n>      # terminal memory/CPU in a dev host; scripts/bench-terminal.mjs in plain Node

`--session <key>` makes separate calls one agent session; use two keys to act as two agents.
In a dev host extra tools exist (`core/debugTools.ts`): `debug_vscode_command` runs any VS Code
command (open a tab or terminal "as the user"), `debug_answer_prompts` queues answers for the
extension's user prompts and returns the prompts shown so far; `debug_extension_eval`
(`remote/debug.ts`) runs JavaScript in the extension host (in a remote dev host: the remote side). All user prompts go through
`services.prompts.ask`, which is what makes them testable.
After changing extension code, restart the dev host (`--stop`, then start) to load the new build.

## Rules

- **Never touch the user's real setup.** No writes to `~/.claude.json`, `~/.claude/`, `~/.codex/`,
  `~/.vscode/` or `~/.copane/`, and never start, stop or reconfigure their own VS Code.
  Dev hosts are fully isolated under `/tmp/copane-dev/<name>/`; use a `--name` unique to your
  task, and never `pkill` by a pattern that could match another dev host or the user's VS Code.
  Code that edits user config is tested against a temporary directory.
- The user is working on this machine. Open as few windows as you need, stop your dev hosts when you
  are done, and do not use desktop mouse or keyboard automation.
- Module boundaries: a module is one folder under `src/extension/` and talks to the others only
  through `core/services.ts`. Each module declares its commands, settings, views and menus in its own
  `contributes/<module>.json` (merged into `package.json` by the build; never edit `contributes` in
  `package.json` by hand).
- `src/extension/core/` and `src/shared/` are shared contracts. Change them only when necessary, keep
  changes additive, and say so in your report.
- Core logic that does not need `vscode` stays free of it and gets unit tests in `test/unit/`.
  Behaviour that depends on VS Code is verified against a dev host through `scripts/mcp-call.mjs`.
- Tool descriptions, tool results and error messages are read by a model. Say what happened and what
  to do next; return compact text, not raw protocol dumps.
- Every module leaves a repeatable `test/e2e/<module>.e2e.mjs` built on `test/e2e/harness.mjs`
  (see `core.e2e.mjs`) that passes against a fresh dev host. Fixture pages and servers it needs live
  in `test/fixtures/` and are started by the test itself on a free port.
  A case that needs something a machine may lack (a command, IPv6 loopback, a public site) declares it
  with `test(name, fn, { skip: reason })` so it reports `SKIP` with the reason; new suites go into
  `SUITES` in `scripts/e2e.mjs`, which CI (`.github/workflows/`) runs.
- TypeScript strict, no new runtime dependencies without a reason (they are bundled into the VSIX).
