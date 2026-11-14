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
  Registered with agents under the name `copane`, so tools appear as `mcp__copane__browser_click`.
- **Bridge server** (`core/bridgeServer.ts`): one per window, in the extension host. Authenticates by a
  token from the instance file (`<bridge home>/instances/<pid>.json`, mode 0600). One connection = one
  agent session.
- **Wire protocol** (`src/shared/protocol.ts`): JSON-RPC, one object per line. Tool definitions live only
  in the extension, so the MCP server never needs to know them.
- **Sessions** (`core/sessions.ts`): each connection presents a `sessionKey`; reconnecting with the same
  key within the grace period resumes the session. A session has a label ("Claude 2"), a badge ("C2"),
  a color and an optional title the agent sets (`session_set_title`). These are what the user sees on
  tabs, terminals and in the Sessions view. Sessions are remembered in the window's workspace state:
  after a reload (or a restart within 10 minutes) the window's sessions are restored as disconnected
  ones in their grace period (at least 30 s), so each gets its label, color and title back whatever
  order the agents reconnect in, and no new session takes their number meanwhile. An ended session
  that returns later gets its color and title back, and its number if it is still free.
- **Tools** (`core/tools.ts`): modules define tools with `defineTool` (zod input, handler) and register
  them. Handlers get `{ session, signal, log }`, return text or content blocks, and throw `ToolError`
  for expected failures.
- **Services** (`core/services.ts`): `BrowserService` and `TerminalService` are the only way modules
  see each other. The UI module renders from these plus `SessionManager`.

Windows are independent: each has its own extension host, bridge server, sessions, tabs and
terminals. Routing an agent to the right window happens once, in the MCP server, at connect time.
In a WSL or SSH window the extension runs on the remote side (`extensionKind: workspace`), where the
agent and its MCP server also run; the browser itself stays on the UI side and VS Code proxies it.

## Remote windows

One extension runs in one place; in a remote window (WSL, SSH, containers) that is the remote side.
What crosses to the user's machine (the UI side), verified in a real remote window (an attached
container, `scripts/remote-dev-host.mjs`):

- `vscode.workspace.fs` with **`vscode-local:`** URIs reads and writes any file the user can on the UI
  side (VS Code's URI transformer maps `vscode-local` to the UI's `file` scheme; `vscode-userdata` does
  too). `file:` is the remote disk. `workspace.fs.copy(vscode-local → file)` copies UI → remote.
- CDP `Page.setDownloadBehavior` takes a path **on the UI side**: the browser saves there.
- Not given: the user's home folder on the UI side. `remote/uiSide.ts` finds it (remembered value,
  argv.json as VS Code's "Configure Runtime Arguments" opens it, WSL's inherited Windows paths, or the
  one home under `C:\Users`, `/Users`, `/home` with this VS Code's data folder and an argv.json).
  Development hosts use `COPANE_UI_HOME` instead and never look for the real one.

So no companion extension on the UI side is needed. `services.remote` (`RemoteService`) gives the
folders; downloads stage on the UI side and are copied to the remote agent folder
(`browser/page/downloadStaging.ts`); enabling the browser edits the UI side's argv.json directly
(`registration/remoteArgv.ts`). When the home cannot be found, downloads fall back to VS Code's Save
dialog and the agent is told the file is on the user's computer, and enabling falls back to the
argv.json editor. Not verified for real: Windows paths (`/c:/Users/...`), WSL itself.

## Browser rules

- Built on the proposed `browser` API (`src/typings/vscode.proposed.browser.d.ts`) plus CDP through
  `BrowserTab.startCDPSession()`. Without the proposal enabled, `browser.available` is false, browser
  tools return a clear "not enabled" error and the UI offers to enable it.
- Every tab of the window is listed, whoever opened it. A tab is `origin: agent` (opened by a session)
  or `origin: user`.
- **Consent**: a session may use its own tabs and tabs of sessions that have ended freely. Reading or
  controlling a user tab needs the user's permission for that session (setting
  `copane.browser.userTabs`: `ask` (default) / `allow` / `deny`).
- **Leases**: mutating actions take the tab's control lease (`core/leases.ts`, `services.tabLeases`).
  A second session gets a `busy` error naming the holder, unless the lease is idle. Reads are never
  blocked by a lease. Leases end on release, idle timeout or session end.
- **User takeover**: the user can pause a tab; agent actions are then refused with a message telling
  the agent to wait for the user. Resuming gives control back.
- **Hand-off** (`browser/handoff.ts`): `browser_request_user_input` hands a tab to the user (sign-in
  with SSO/MFA, captcha, consent, a choice) by pausing it, the same state as a user takeover, so no
  agent reads or acts in it meanwhile. The page indicator shows the request with Done / Won't do; the
  views and status bar count it like a terminal waiting for the user (`BrowserTabInfo.request`); a
  notification appears only while the tab is out of sight, because VS Code pauses a browser view a
  notification covers. It ends on the agent's `done_when` condition, the user's answer, timeout, cancel,
  session end or tab close. Before the pause ends, requests sent meanwhile lose URL query, headers and
  bodies, console messages lose their text (`page/privacy.ts`, `NetworkEntry.withheld`), and password
  and one-time-code fields still on the page are emptied. Anything new that exports or reads recorded
  requests must honour `withheld`.
- **Marking**: a tab in use shows which session uses it, in the page (unobtrusive indicator in the
  session color, never in screenshots the agent takes) and on the editor tab where VS Code allows it.
- Tools take an optional `tab`; without it they act on the session's current tab (the one it last
  opened or used), never on "whatever is focused".
- **Frames**: cross-origin iframes are separate CDP targets (site isolation). Each tab's page session
  auto-attaches to them (`page/frames.ts`; nested ones through each frame's session) and records
  their console and network into the tab's logs. Snapshots read them in place (bounded,
  `page/frameSnapshot.ts`), refs remember their frame and its document, and input still goes to the
  page target at coordinates mapped out through each `<iframe>` (`page/frameTargets.ts`). The page
  indicator and certificate handling stay on the page target only.
- **Request interception**: CDP `Fetch` of a tab has one owner, `browser/interception.ts`. Anything
  that holds, answers or changes requests (login prompts in `credentials.ts`, request mocking in
  `routes.ts`) is a `FetchClient` registered there; never call `Fetch.*` directly. `Fetch` is enabled
  only while some client needs it on that tab, and every paused request is answered. It covers the
  tab's page target and every out-of-process iframe (nested and later ones too): the frame registry
  holds a new frame before its document runs (`waitForDebuggerOnStart`, bounded, always released)
  until interception is in place there, so even a frame's first request is covered. At most 100
  frames per tab; workers are not covered.
- **Test recording**: `page/recorder.ts` keeps, per session and tab, the steps of the session's
  successful page tool calls (it wraps their handlers and is a `PageHook`: `observeCall`,
  `targetResolved`). A Playwright locator is chosen when an action resolves its element
  (`page/locators.ts`, checked to match only that element); `browser_export_test` prints the steps as a
  test (`page/testCode.ts`). Values typed into secret fields are never stored, only an env var name.
- **Throttling** (`page/throttle*.ts`, part of `browser_emulate`): CDP `Network.emulateNetworkConditions`
  and `Emulation.setCPUThrottlingRate`, sent to the page target and to every cross-origin frame target
  (separate processes the page's settings do not reach). Both outlive the CDP session that set them (CPU
  throttling stays on the renderer process), so a tab is remembered in workspace state before it is
  throttled, and the next run of the extension attaches to it and undoes it. Responses the bridge
  answers itself (`browser_route` mocks) never reach the network and are not throttled.
- **HAR export** (`page/har*.ts`, `browser_network_requests` with `har`): the tab's network log as HAR 1.2,
  written like `browser_export_test` writes tests (`page/agentFile.ts`). Cookie values and secret-looking
  headers, query parameters and body fields are masked unless the agent asks; `withheld` entries stay
  withheld; response bodies only on request.
- **Audits**: `browser_audit` runs axe-core (shipped unmodified as `dist/axe.min.js`, read when first
  used) in the bridge's isolated world of each document, and reads the performance timeline there
  too. A tab in the background is painted rarely, which delays paint-bound numbers (interactions).

- **Login profiles** (`browser/profiles/`): a tab can be opened in a named profile, a separate
  in-memory login store (a CDP browser context created through a tab's CDP session; VS Code opens
  `Target.createTarget` with `browserContextId` as a real tab). Tabs of one profile share logins.
  The service's `opener` hook routes `openTab` there; `BrowserTabInfo.profile` shows it everywhere.
  Profiles do not survive a VS Code restart; see `docs/browser-profiles.md` for what does.
- **Tab ids across a window reload**: every tab is remembered with its id and URL, and with VS Code's
  view id once the bridge has attached to it. After a reload a tab gets its id back by view id, or by
  URL when that is unambiguous (`browser/tabRestore.ts`); the bridge never attaches to a tab nobody
  shared just to recognise it. Tabs that cannot be told apart (same URL) get new ids; their old ids
  are retired, never reused, and a call with one says what happened.
- **Prompts and the browser**: VS Code pauses a browser view while a notification toast or the
  notification centre overlaps it (it hides the view and shows a dimmed screenshot; screenshots of
  it take seconds, a tab opened meanwhile keeps a 1024×768 placeholder size). So questions about a
  tab (consent, certificate errors, logins, downloads) use `placement: "statusBar"` in
  `services.prompts.ask`: a status bar item, which covers nothing, that opens the question in VS
  Code's modal dialog when clicked (`core/promptStatus.ts`, command `copane.answerQuestion`). Only
  the user can answer it: the command takes no arguments and only shows the dialog.

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
  (`copane.terminal.userTerminals`: `ask` / `allow` / `deny`).
- **Cost**: a headless emulator with a 4000-line scrollback costs up to ~7 MB and parses output at
  25-130 MB/s. Agent terminals get one at once. The user's own terminals keep only the raw last 64 kB
  (`terminal/tail.ts`) until an agent is allowed in; the mirror then starts from that tail, so the
  agent sees the screen and the recent output (older output is reported as cut off), and it is
  released when no live session uses the terminal any more. Closed terminals are released (a mirror
  an agent used after 60 s, so a waiting tool can still report). The mirror feeds xterm.js a slice at
  a time; under a backlog it parses at most about a third of the time and skips lines that would
  scroll out of the scrollback anyway, keeping shell-integration markers and screen modes.
- **Names**: an agent terminal is named after its session's label. Labels come back after a reload
  (see Sessions); when a session returns under another label, its terminals are renamed as soon as
  they are the active terminal (VS Code can rename only the active terminal, and cannot change a
  terminal's color after creation).

## Layout

    src/shared/            wire protocol, JSON-RPC peer, paths (used by both bundles)
    src/mcp/               MCP stdio server and window discovery
    src/extension/core/    sessions, leases, tool registry, bridge server, service interfaces
    src/extension/browser/ BrowserService, CDP, browser_* tools, tab marking
    src/extension/terminal/ TerminalService, terminal_* tools
    src/extension/remote/  RemoteService: the user's machine as seen from a remote window
    src/extension/ui/      Sessions view, Agent Tabs panel view, status bar, user commands, browser-API setup
    src/extension/registration/  registering the MCP server with Claude Code and Codex
    contributes/*.json     per-module manifest fragments, merged into package.json by the build
    scripts/               dev host and MCP test client
    poc/                   the original feasibility probe (reference only)

## Tool definitions cost context

Every tool definition (name, title, description, input schema, annotations) is sent to the model in
every conversation; Codex also appends the server instructions to each Copane tool it looks up.
`test/unit/tool-budget.test.ts` collects the tools the way the modules register them and fails when
the total, any one tool or the instructions grow past their budget. When it fails, shorten the wording
first: the first sentence says what the tool is for; a parameter is described only where its name and
type do not say it; guidance shared by many tools goes once into `core/instructions.ts` (Claude Code
cuts the server's instructions at 4096 characters). A new module that registers tools must be added to
that test. `scripts/measure-tokens.mjs` measures the same list, and result sizes, on a dev host.

## Getting started

`contributes/walkthrough.json` is the getting-started walkthrough; `registration/setup.ts` decides the
setup state (browser, agents, a session seen) from plain data and `registration/walkthrough.ts`
publishes it as `copane.setup.*` context keys and checks the steps off with VS Code's
`welcome.markStepComplete` (VS Code ignores an `onContext` completion whose key was already true when
the walkthrough registered). The Sessions view's welcome content uses the same keys. Walkthrough SVGs
use theme colors as presentation attributes (`fill="var(--vscode-foreground, #3b3b3b)"`): the
webview that shows them blocks `<style>`.
