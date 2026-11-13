# Contributing to Copane

Thanks for helping. Bug reports with a status report are the most useful thing you can send: run
**Copane: Copy Status Report** in VS Code and paste the result into the issue.

## Before you change code

Read `CLAUDE.md` (the project's rules) and `docs/ARCHITECTURE.md`. Copane builds on VS Code's
*proposed* `browser` API; `docs/feasibility-assessment.md` lists what is known about it.

## Checks

You need Node.js 22 or newer and VS Code 1.140 or newer with `code` on the PATH.

    npm ci
    npm run check          # typecheck, unit tests, build: must pass before a pull request

## Trying a change in VS Code

A dev host is an isolated VS Code with the extension loaded from your working tree. It has its own
profile, settings and throwaway Claude Code / Codex configuration under `/tmp/copane-dev/<name>/`
(`%TEMP%\copane-dev\<name>\` on Windows), so your own setup is never touched.

    node scripts/dev-host.mjs --name try           # builds, then opens the window
    node scripts/mcp-call.mjs --name try --list    # the tools, through the real MCP server
    node scripts/mcp-call.mjs --name try --session s1 browser_open '{"url":"https://example.com"}'
    node scripts/dev-host.mjs --name try --stop

After changing extension code, stop and start the dev host again to load the new build.

## End-to-end tests

Each module has a suite in `test/e2e/` that drives a dev host the way an agent does.

    node scripts/e2e.mjs                    # the suites, each against its own fresh dev host
    node scripts/e2e.mjs terminal ui        # some of them
    node scripts/e2e.mjs --vscode insiders  # against a downloaded VS Code (stable, insiders or a version)

A case that needs something your machine lacks (`openssl`, the IPv6 loopback address) is reported
as `SKIP` with the reason. `COPANE_E2E_OFFLINE=1` skips the cases that load real public sites.

## Continuous integration

The workflows in `.github/workflows/` call scripts in `scripts/`, so everything they do runs locally too.

- **Checks** (`checks.yml`): `npm run check` on Linux, macOS and Windows for every push and pull
  request. The end-to-end suites (`scripts/e2e.mjs`) on Linux for pull requests and `main`; on Windows
  for `main` only and as an experiment that does not fail the run.
- **Release** (`release.yml`): pushing a tag `v<version>` checks that it matches `package.json`, runs
  the checks, and creates the GitHub release with the VSIX and the version's `CHANGELOG.md` section
  (`scripts/release-notes.mjs`). It publishes to the Marketplace and Open VSX only when the
  `VSCE_PAT` / `OVSX_PAT` secrets are set.
- **VS Code canary** (`vscode-canary.yml`): nightly, the suites against VS Code Insiders and the
  vendored proposed-API typings against microsoft/vscode (`scripts/check-proposed-api.mjs`); keeps one
  issue labelled `vscode-canary` up to date while something is wrong (`scripts/canary-issue.mjs`).

## Pull requests

Keep a pull request to one change, add or update tests for it, and add a line to `CHANGELOG.md`
under the next version when users will notice it.

## License of contributions

Copane is licensed under the [PolyForm Shield License 1.0.0](LICENSE). By opening a pull request you
confirm that you license your contribution under that same license, and that you have the right to.
Please say so in the pull request description (the template has a checkbox for it).
