# Agent Bridge: Browser & Terminal for Claude Code

Agent Bridge gives Claude Code (and Codex, and other MCP agents) the VS Code window they run in:
its **integrated browser tabs** and its **integrated terminals**. The agent and you work in the
same tabs and the same terminals. You see every click and every command, and you can take over at
any moment.

- An agent opens your dev server in a browser tab next to your code, clicks through it, reads the
  console, takes screenshots, and you watch it happen.
- An agent starts a dev server or a test run in a real terminal you can see and type into. When a
  command needs you (a password, a 2FA code, a browser login), it hands the terminal to you instead
  of asking for secrets in chat.
- Several agent sessions can work in one window, in several windows at once, each with its own
  label and color ("Claude 1", "Claude 2") on the tabs and terminals it uses.

It works with the **Claude Code extension for VS Code** (its chat sessions), with the **`claude`
CLI** in the integrated terminal, and with **Codex** (`codex` CLI and extension).

## Install

1. Install **Agent Bridge** from the Marketplace, or a `.vsix` with
   `code --install-extension vscode-agent-bridge-<version>.vsix`.
2. When VS Code asks *"let Claude Code and Codex use this VS Code's browser tabs and terminals?"*,
   choose **Register**. This adds an MCP server named `vscode` to your user configuration of the
   agents that are installed (see [what changes on your machine](#what-changes-on-your-machine)).
3. Enable the integrated browser for Agent Bridge (once): run **Agent Bridge: Enable Integrated
   Browser** from the Command Palette, then **quit VS Code completely and start it again**.
4. Start a new Claude Code session. Ask it, for example, *"open http://localhost:3000 in the VS
   Code browser and check the login form"*.

Sessions that were already running before step 2 do not see the new server; start them again
(in Claude Code, `/mcp` shows the `vscode` server and its state).

### Why the browser needs a restart

VS Code's integrated browser is controlled through an API that is still marked *proposed*. VS Code
lets an extension use a proposed API only when you allow it by name, with
`"enable-proposed-api": ["sak0a.vscode-agent-bridge"]` in VS Code's `argv.json` (the file behind
**Preferences: Configure Runtime Arguments**). VS Code reads that file only when it starts, so
reloading the window is not enough. The command edits the file for you, keeps everything else in
it, and offers to quit VS Code. Until then, everything except the browser tools works.

## Tools

The agent sees the tools as `mcp__vscode__<tool>`:

- **`browser_*`**: list, open and close tabs; navigate; read the page (accessibility snapshot,
  text, console, network); click, type, fill forms, evaluate scripts; screenshots.
- **`terminal_*`**: create terminals, run commands and read their output and exit codes, send
  input, wait, interrupt, and hand a terminal to you when it needs a person.
- **`session_info`**, **`session_set_title`**: who the agent is in this window, and a short title
  for its task that you see next to its label.
- **`window_status`**, **`window_select`**: which VS Code window the session uses and why, and
  switching to another one. These two work even when no window is reachable, so an agent can
  always explain why the other tools are missing.

### Tool reference

Tools appear in Claude Code as `mcp__vscode__<name>`.

| Area | Tools |
|---|---|
| Session and window | `session_info`, `session_set_title`, `window_status`, `window_select` |
| Browser tabs | `browser_list_tabs`, `browser_open`, `browser_select_tab`, `browser_show_tab`, `browser_release_tab`, `browser_close_tab` |
| Navigation | `browser_navigate`, `browser_history` (back, forward, reload) |
| Reading a page | `browser_snapshot` (accessibility tree with element refs), `browser_screenshot`, `browser_wait_for` |
| Acting on a page | `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_scroll`, `browser_drag`, `browser_upload_file`, `browser_handle_dialog`, `browser_evaluate` |
| Debugging a page | `browser_console_messages`, `browser_network_requests`, `browser_network_request` |
| Terminals | `terminal_run`, `terminal_read`, `terminal_wait`, `terminal_send`, `terminal_interrupt`, `terminal_request_user_input` (hand a login or prompt to the user), `terminal_create`, `terminal_list`, `terminal_close` |

The session indicator in a page can be dragged to any corner; it stays there for that tab and new
tabs start in the corner you last chose.

**Certificate errors.** When an agent opens a site whose certificate the system does not trust
(self-signed, or issued by a company authority), you are asked once per host: *Proceed*, *Always
Trust <host>*, or *Cancel*. *Always Trust* adds the host to
`agentBridge.browser.trustedCertificateHosts`, which you can also fill yourself, e.g.
`["localhost", "*.corp.example"]`. Set `agentBridge.browser.certificateErrors` to `block` to never
proceed for agents. This applies only to tabs an agent session is driving.

Known limits: content of cross-origin iframes is not in snapshots (use a screenshot and click by
coordinates); JavaScript `prompt()` is not available in VS Code's browser; without shell integration
a terminal command's exit code is unknown.

## How it works

```
Claude Code session ──stdio MCP──▶ ~/.vscode-agent-bridge/bin/mcp-server ──local socket──▶ VS Code window
(chat tab or `claude` CLI)          (one small process per session)                        (Agent Bridge extension)
```

Every agent session starts its own copy of the MCP server. The server finds the VS Code window the
session belongs to, connects to that window over a local socket, and forwards the tools. All tool
logic runs in the extension, in the window.

### Which window a session uses

The server picks the window like this, and reports how it chose (`window_status`):

1. The agent was started by an extension in that window, for example a chat of the Claude Code
   extension: the window's extension host is one of its parent processes.
2. The agent runs in one of that window's integrated terminals (Agent Bridge sets
   `AGENT_BRIDGE_INSTANCE` in its terminals).
3. The window it was connected to before was reloaded: the new window with the same folders.
4. The agent's working directory is inside the window's workspace (deepest folder wins; if the
   same folder is open twice, the most recently focused window).
5. Only one VS Code window is open.

If several windows are open and none of these applies (an agent started outside VS Code, in a
folder no window has open), the server does not guess. The agent sees `window_status`, which lists
the open windows, and connects with `window_select`.

### Several sessions, several windows

Each session gets a label and a color in its window ("Claude 2", blue) shown on the tabs and
terminals it uses. A session may freely use the tabs and terminals it opened. Using a tab or
terminal *you* opened needs your permission. When two sessions want the same tab, one controls
it and the other can still read it.

A session is identified by Claude Code's conversation id, so it keeps its identity when the window
reloads (the server reconnects by itself and calls wait for the window to come back) and when you
resume the conversation with `claude --resume`. Sub-agents of a conversation share its session.
Windows are independent: each has its own sessions, tabs and terminals.

### Codex

Codex is registered the same way, in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Codex
starts MCP servers with only a few environment variables, so the entry lists the ones Agent Bridge
needs (`env_vars`), and it raises Codex's 60-second tool timeout to 10 minutes for long browser
waits and terminal commands.

### Remote windows and WSL

In a WSL, SSH or Dev Container window, Agent Bridge runs on the remote side, next to your code,
where Claude Code and Codex run too. It registers with the agents' configuration **on the remote
machine** (for WSL: `~/.claude.json` inside WSL), and the server runs with the VS Code server's
Node.js. The browser itself stays on your local machine and VS Code connects it through the window,
so `localhost:3000` in a WSL window reaches the server in WSL.

The browser setting, `argv.json`, belongs to your local VS Code. In a remote window, **Agent Bridge:
Enable Integrated Browser** opens it through **Preferences: Configure Runtime Arguments** and adds
the line there. If that does not work in your setup, it shows the line to add and copies it to the
clipboard. Then quit VS Code on your local machine and start it again.

On native Windows (no WSL), agents start the server with VS Code's own executable
(`Code.exe` with `ELECTRON_RUN_AS_NODE=1`), which Agent Bridge updates when VS Code moves.

## What changes on your machine

Agent Bridge asks before it changes any agent's configuration, and changes only what it describes:

| File | Change | When |
|---|---|---|
| `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | `mcpServers.vscode`, a user-scope MCP server | After you agree, or with the Register command. Made with Claude Code's own `claude mcp` command when it is available, so it does not race with a running Claude Code. |
| `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) | the `[mcp_servers.vscode]` table | Same. The rest of the file, comments included, is left exactly as it was. |
| VS Code's `argv.json` | adds Agent Bridge to `enable-proposed-api` | When you run **Enable Integrated Browser**. Comments and other entries are kept. |
| `~/.vscode-agent-bridge/` | the MCP server, a small launcher, one file per open window (socket path and a random token, readable only by you) | Always; this is Agent Bridge's own folder. |

Agent Bridge never changes or removes a `vscode` MCP server that it did not add. If you already
have one, it asks whether to replace it. Its own entry points to
`~/.vscode-agent-bridge/bin/mcp-server`, which stays the same across extension updates, so your
agent configuration does not need to change when the extension updates.

**Unregister** with **Agent Bridge: Unregister from Claude Code and Codex**. It removes Agent
Bridge's entries and nothing else, and Agent Bridge does not add them back on its own. Run it
before uninstalling the extension if you do not plan to reinstall it.

## Security model

- **Local only.** The windows listen on a Unix socket in `~/.vscode-agent-bridge/run/` (a named pipe
  on Windows), never on a network port. The folder is readable only by you, and every connection
  must present the window's random token, which is in a file only you can read.
- **Your tabs and terminals are yours.** An agent can use the tabs and terminals it opened. To read
  or control a tab or terminal you opened, it needs your permission (settings
  `agentBridge.browser.userTabs` and `agentBridge.terminal.userTerminals`: ask, allow or deny).
- **You can always take over.** Pause an agent's access to a tab, type into its terminals, or end a
  session from the Sessions view.
- **Secrets stay with you.** When a command needs a password or a login, the agent hands you the
  terminal; it sees only what the terminal shows afterwards.
- An agent that can use the browser can do in it whatever you could: treat it like any other tool
  you allow an agent to use, and keep Claude Code's permission prompts on for actions you want to
  confirm.

## Commands

| Command | |
|---|---|
| Agent Bridge: Register with Claude Code and Codex | Adds (or repairs) the `vscode` MCP server in the agents' user configuration. |
| Agent Bridge: Unregister from Claude Code and Codex | Removes Agent Bridge's entries. |
| Agent Bridge: Enable Integrated Browser | Allows the proposed browser API in `argv.json` and offers to quit VS Code. |
| Agent Bridge: Show Status | Everything about this window, the browser, the agents and the connected sessions, in one copyable report. |
| Agent Bridge: Show Log | The extension's log. |

## Settings

| Setting | Default | |
|---|---|---|
| `agentBridge.registration.mode` | `ask` | `ask`: ask once before registering. `automatic`: register without asking. `manual`: only the commands change agent configuration. |
| `agentBridge.registration.claudeCode` | `true` | Register with Claude Code. |
| `agentBridge.registration.codex` | `true` | Register with Codex (when it is installed). |
| `agentBridge.sessionGraceSeconds` | `20` | How long a disconnected session keeps its tabs and terminals, so it can reconnect after a reload. |

## Troubleshooting

Run **Agent Bridge: Show Status** first. It checks each of the following and says what to do.

**Claude Code does not list the `vscode` server.** Start a new session: agents read their MCP
configuration when a session starts. Check that the status report says *registered ✓* for Claude
Code. If you use `CLAUDE_CONFIG_DIR`, VS Code must be started with the same value. A project can
override user-scope servers with its own `vscode` server (`.mcp.json`, or `claude mcp add` in local
scope); the report lists such projects.

**The server is listed but has no browser or terminal tools.** Ask the agent to call
`window_status`. Typical answers: no VS Code window with Agent Bridge is open (the tools appear on
their own a few seconds after one opens), or several windows are open and the agent was started
outside all of them (it can pick one with `window_select`).

**Browser tools say the browser is not enabled.** Run **Enable Integrated Browser** and quit and
restart VS Code completely. If the report says *enabled in argv.json, but VS Code has not been
restarted*, the restart is what is missing.

**After a window reload, an agent's call failed.** A call that was running at the moment of the
reload cannot finish; the agent is told so and can repeat it. Calls made during the reload wait for
the window to come back.

**`node` is not installed.** Not needed: the server runs on VS Code's own runtime.

**The self-test fails with "could not be started".** The launcher in
`~/.vscode-agent-bridge/bin/` points to a VS Code that is no longer there. Opening a window with
Agent Bridge rewrites it.

Still stuck: copy the status report and the output of **Agent Bridge: Show Log** into an issue.

## Development

See `CLAUDE.md` and `docs/ARCHITECTURE.md`. `npm run check` type-checks, tests and builds;
`node scripts/dev-host.mjs --name <name>` starts an isolated VS Code with the extension and with
throwaway Claude Code, Codex and `argv.json` configuration.

## Acknowledgements

Agent Bridge builds on ideas from
[thimo/vscode-integrated-browser-mcp](https://github.com/thimo/vscode-integrated-browser-mcp)
(MIT, © Thimo Jansen): driving the integrated browser through the proposed API and CDP, finding the
right window through per-window instance files and the working directory, and copying the MCP
server to a stable location outside the extension folder.

## License

MIT © sak0a. See the LICENSE file.
