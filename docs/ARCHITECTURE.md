# Architecture

## Goal

An agent (Claude Code first, any MCP client in principle) works in the same VS Code as the user:
the same integrated browser tabs, the same integrated terminals. Several agent sessions can run in
one window and in several windows at once without stepping on each other, the user always sees which
session is using what, and can take over at any moment.

## Pieces

    Claude Code session ──stdio MCP──▶ dist/mcp-server.js ──unix socket / named pipe──▶ extension host of the window
    (chat tab or `claude` CLI)         (one process per session,                         (BridgeServer → ToolRegistry →
                                        thin proxy, no tool logic)                         browser / terminal modules)

- **MCP server** (`src/mcp/`): spawned by the agent, one per agent session. Finds its window
  (`discovery.ts`: terminal env var → extension-host ancestor → cwd inside a workspace folder → only
  window), connects to that window's socket, sends `hello`, then forwards `tools/list` and `tools/call`.
  Registered with agents under the name `vscode`, so tools appear as `mcp__vscode__browser_click`.
- **Bridge server** (`core/bridgeServer.ts`): one per window, in the extension host. Authenticates by a
  token from the instance file (`<bridge home>/instances/<pid>.json`, mode 0600). One connection = one
  agent session.
- **Wire protocol** (`src/shared/protocol.ts`): JSON-RPC, one object per line. Tool definitions live only
  in the extension, so the MCP server never needs to know them.
- **Sessions** (`core/sessions.ts`): each connection presents a `sessionKey`; reconnecting with the same
  key within the grace period resumes the session. A session has a label ("Claude 2"), a badge ("C2"),
  a color and an optional title the agent sets (`session_set_title`). These are what the user sees on
  tabs, terminals and in the Sessions view.
- **Tools** (`core/tools.ts`): modules define tools with `defineTool` (zod input, handler) and register
  them. Handlers get `{ session, signal, log }`, return text or content blocks, and throw `ToolError`
  for expected failures.
- **Services** (`core/services.ts`): `BrowserService` and `TerminalService` are the only way modules
  see each other. The UI module renders from these plus `SessionManager`.

Windows are independent: each has its own extension host, bridge server, sessions, tabs and
terminals. Routing an agent to the right window happens once, in the MCP server, at connect time.
In a WSL or SSH window the extension runs on the remote side (`extensionKind: workspace`), where the
agent and its MCP server also run; the browser itself stays on the UI side and VS Code proxies it.

## Browser rules

- Built on the proposed `browser` API (`src/typings/vscode.proposed.browser.d.ts`) plus CDP through
  `BrowserTab.startCDPSession()`. Without the proposal enabled, `browser.available` is false, browser
  tools return a clear "not enabled" error and the UI offers to enable it.
- Every tab of the window is listed, whoever opened it. A tab is `origin: agent` (opened by a session)
  or `origin: user`.
- **Consent**: a session may use its own tabs and tabs of sessions that have ended freely. Reading or
  controlling a user tab needs the user's permission for that session (setting
  `agentBridge.browser.userTabs`: `ask` (default) / `allow` / `deny`).
- **Leases**: mutating actions take the tab's control lease (`core/leases.ts`, `services.tabLeases`).
  A second session gets a `busy` error naming the holder, unless the lease is idle. Reads are never
  blocked by a lease. Leases end on release, idle timeout or session end.
- **User takeover**: the user can pause a tab; agent actions are then refused with a message telling
  the agent to wait for the user. Resuming gives control back.
- **Marking**: a tab in use shows which session uses it, in the page (unobtrusive indicator in the
  session color, never in screenshots the agent takes) and on the editor tab where VS Code allows it.
- Tools take an optional `tab`; without it they act on the session's current tab (the one it last
  opened or used), never on "whatever is focused".

## Terminal rules

- Agent terminals are real integrated terminals, named and colored after their session, visible to
  the user, who can type into them at any time.
- Commands run through shell integration, which gives output and exit codes. Output is returned as
  the text a person would see (control sequences interpreted, not just stripped).
- A long-running command returns after a timeout with what it printed so far and stays running; the
  agent reads more, waits, sends input or interrupts.
- **Hand-off**: `terminal_request_user_input` shows the terminal and tells the user what is needed
  (login, password, 2FA); the agent never sees what the user types beyond the terminal's own output,
  and resumes when the command finishes or the user says they are done.
- Terminals the user created are listed but need permission before an agent reads or writes them
  (`agentBridge.terminal.userTerminals`: `ask` / `allow` / `deny`).

## Layout

    src/shared/            wire protocol, JSON-RPC peer, paths (used by both bundles)
    src/mcp/               MCP stdio server and window discovery
    src/extension/core/    sessions, leases, tool registry, bridge server, service interfaces
    src/extension/browser/ BrowserService, CDP, browser_* tools, tab marking
    src/extension/terminal/ TerminalService, terminal_* tools
    src/extension/ui/      Sessions view, status bar, user commands, browser-API setup
    src/extension/registration/  registering the MCP server with Claude Code and Codex
    contributes/*.json     per-module manifest fragments, merged into package.json by the build
    scripts/               dev host and MCP test client
    poc/                   the original feasibility probe (reference only)
