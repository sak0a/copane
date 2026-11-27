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
  (`discovery.ts`: terminal env var → extension-host ancestor → cwd inside a workspace folder → cwd in
  a git worktree whose main checkout is in a workspace folder → only window), connects to that window's socket, sends `hello`, then forwards `tools/list` and `tools/call`.
  `initialize` (3 s) and a tool call (4 s) wait for a window only while one can be expected
  (`BridgeClient.expectsWindow`): the session had one, the agent chose one, a matching window has not
  answered yet, or the agent was started from VS Code (`COPANE_INSTANCE`, `TERM_PROGRAM=vscode`, any
  `VSCODE_*` variable), whose window may still be starting. An agent started elsewhere with no window
  to find is answered at once; a window that opens later is found by the background poll.
  Registered with agents under the name `copane`, so tools appear as `mcp__copane__browser_click`.
- **VS Code chat conversations** (`src/mcp/conversations.ts`): VS Code's own MCP client runs one
  server process per window for all its chats and names the chat in each `tools/call` as
  `_meta["vscode.conversationId"]`. A call with it goes through a `BridgeClient` of that conversation:
  its own connection (the protocol has one session per connection), session key
  `vscode-chat:<sha256 of the id>` (below `COPANE_SESSION` when set), window choice and reconnects.
  Calls without it, and `tools/list`, use the process's default client, which alone sends
  `tools/list_changed`. `window_select` moves only the calling conversation; a conversation created
  later starts in the window chosen last. At most 16 conversations stay connected (least recently
  used closed first) and one idle for 30 minutes is closed, never during a call; the window then
  treats it like an exited agent (grace period, then the session ends), and a conversation that
  returns resumes its session by key. The default session stays connected but unused by chats.
- **Bridge server** (`core/bridgeServer.ts`): one per window, in the extension host. Authenticates by a
  token from the instance file (`<bridge home>/instances/<pid>.json`, mode 0600). One connection = one
  agent session. A client known not to give its model the server's MCP `instructions` (Copilot CLI,
  `dropsServerInstructions`) gets them once per session, appended to its first successful tool result
  (setting `copane.usageNotesInResults`, `usageNotesPolicy`).
- **Tool selection** (`core/toolSelection.ts`, plain data): the settings `copane.tools.profile`
  (`full` / `core`) and `copane.tools.disabled` decide which tools the bridge lists; a call to one that
  is off gets a refusal saying which setting and what to use instead (`CORE_PROFILE_EXCLUDES`, each
  exclusion explained there). Read at every list and call; a settings change calls
  `BridgeServer.notifyToolsChanged`, the same `tools/changed` path as registration, so connected
  clients refetch. The instructions leave out or adapt sentences naming a tool that is off. Tools
  that are always there: `window_status` and `window_select` (answered by the MCP server itself, the
  way to recover from a wrong window) and `debug_*` in a dev host. A new tool is in `core` unless it
  is added to `CORE_PROFILE_EXCLUDES`.
- **Wire protocol** (`src/shared/protocol.ts`): JSON-RPC, one object per line. Tool definitions live only
  in the extension, so the MCP server never needs to know them. The peer (`src/shared/jsonrpc.ts`)
  decodes the socket's bytes with a `StringDecoder`: a long message arrives in chunks (8 kB on macOS)
  that can cut a character of several bytes in two.
- **Sessions** (`core/sessions.ts`): each connection presents a `sessionKey`; reconnecting with the same
  key within the grace period resumes the session. A session has a label ("Claude 2"), a badge ("C2"),
  a color and an optional title the agent sets (`session_set_title`). These are what the user sees on
  tabs, terminals and in the Sessions view. Sessions are remembered in the window's workspace state:
  after a reload (or a restart within 10 minutes) the window's sessions are restored as disconnected
  ones in their grace period (at least 30 s), so each gets its label, color and title back whatever
  order the agents reconnect in, and no new session takes their number meanwhile. An ended session
  that returns later gets its color and title back, and its number if it is still free.
- **Away sessions**: an agent chat reconnects after a reload or restart only when the user continues
  it, and a CLI agent that ran in a terminal is gone, so a restored session whose agent has not
  reconnected after the grace period is not ended: it becomes *away* (`AgentSession.away`), with no
  time limit, for as long as it owns something (`SessionManagerOptions.holds`, wired in
  `extension.ts`: a tab it opened or an open terminal of its own). Its tabs and terminals stay its
  own in the views, the marks and the access rules (another session needs the user's consent), and
  its number stays taken. It ends when the user ends it or closes what it owns (`reviewAway`, on
  every tab or terminal change), and `copane.terminal.onSessionEnd` applies only then. Sessions that
  were away when the window closed, or of a window closed for longer than 10 minutes, come back
  away at once. For the first minute after activation (`AWAY_SETTLE_MS`) none is ended for owning
  nothing, because revived terminals and restored tabs turn up one by one; the views do not list
  an away session that owns nothing. A session that connected in this run and disconnects ends
  after the grace period as before. The browser keeps a session's current tab across its end while
  that tab is its own and open, so a session that comes back goes on in it.
- **Tools** (`core/tools.ts`): modules define tools with `defineTool` (zod input, handler) and register
  them. Handlers get `{ session, signal, log }`, return text or content blocks, and throw `ToolError`
  for expected failures. A call with an argument name the tool does not take is refused, naming the
  valid ones (top-level names only; MCP's `_meta` is ignored); the advertised schema does not say
  `additionalProperties: false`, to keep definitions short. Related actions share one tool with an
  `action` argument only where their annotations agree enough: a merged tool carries the most
  cautious hints of its parts, so read-only listing (`browser_list_tabs`) stays its own tool while
  select/show/release/close are `browser_tab` (`destructiveHint`). Per-action arguments are checked
  in the handler, with a message saying what to pass.
- **Tool aliases** (`core/toolAliases.ts`, plain data): old names of merged tools, one table, kept
  for one release. The bridge server maps a call to one (when no tool of that name is registered) to
  the new call, applies `copane.tools.*` to the new name and the old one, and starts the result with
  a line naming the new call. Never listed.
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
  `BrowserTab.startCDPSession()`. Without the proposal enabled, `browser.available` is false (read
  once at activation: enabling takes a VS Code restart), no browser_* tools are listed (they could
  only fail, and definitions cost every conversation), the instructions and `window_status` say how to
  enable it, and the UI offers to.
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
- **Logins** (`browser/credentials.ts`, HTTP authentication): the bridge answers a site's or proxy's
  login challenge in a tab a session drives by asking the user (`services.prompts`). What VS Code
  does with a challenge nobody answers changed: until 1.147 it cancelled it (the page shows its
  401); since 1.148 it shows a sign-in dialog of its own over the page, the navigation stays
  pending, `Page.navigate` gets no answer, and a tab *opened* straight onto such a page answers no
  CDP command at all until the user has dealt with the dialog. So where VS Code asks itself
  (`vscodeAsksForLogins`) and login prompts are on, a tab a session opens starts on `about:blank`
  and loads its URL once the bridge is attached and interception is in effect (`defersFirstLoad`,
  `BrowserServiceImpl.deferFirstLoad`): the first request is already the bridge's, and it is in the
  network log. The blank document leaves no history entry. With login prompts off the dialog is
  VS Code's and the user's; `browser_open` and `browser_navigate` then say that the page may be
  waiting there (`BrowserService.loginAskedByVsCode`) instead of a bare timeout. Popups opened by
  a page are not covered.
- **"Leave this page?"**: until VS Code 1.147 a page with a `beforeunload` handler opens that dialog
  when it is navigated away from, and the bridge confirms it for a navigation the agent asked for;
  since 1.148 the browser leaves without asking and no dialog is reported.
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
- **Keyboard walk** (`page/keyboard*.ts`, `browser_audit` type `keyboard`): trusted Tab presses,
  focus followed into shadow roots (closed ones through CDP) and frames. Chromium keeps a Tab
  starting point per document, so the walk resets it in every frame first. Nothing stays pending in
  the page between steps (waits are host-side): a command pending across a navigation closes the
  tab's CDP connection. Focus, scroll and selection are restored on every exit path.
- **Element to source** (`page/source*.ts`, `stackFrames.ts`, `workspacePaths.ts`, `browser_inspect`):
  framework data is read in the page's own world (expandos are invisible to the isolated world) and
  treated as untrusted: typed, clipped, cleaned. Scripts and source maps are fetched through the
  browser (`Network.loadNetworkResource`; http(s) only, cookies only same-origin), bounded in size
  and time, cached per tab and document. A path is shown as a workspace file only when that file
  exists inside a workspace folder.
- **Check after a change** (`page/change*.ts`, `png.ts`, `imageDiff.ts`, `browser_check_change`):
  per session and tab, a baseline (downscaled decoded screenshot, log positions) in memory, at most
  10 per window. "check" waits for a hot-update message or request, a reload, an error or a DOM
  change that is not the page changing on its own, then for quiet, and reports what is new since
  the previous check; the screenshot is compared with the baseline. Error locations go through
  `originalLocation` of `source.ts`. `png.ts` is also what the keyboard walk's pixel check decodes with.

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

- **Site icons in the views** (`ui/favicon.ts`, setting `copane.ui.favicons`): tab rows show the icon
  VS Code's browser already shows on the editor tab. `BrowserTab.icon` is a `data:` Uri of what the
  page's own network stack loaded (verified on 1.146: the server's bytes and declared type, even a
  scripted SVG or an 80 KB PNG) or `ThemeIcon('globe')`; `services.browser.tabIcon` passes it on (not in
  `BrowserTabInfo`, so never in tool results). So Copane evaluates nothing in the page, sends no CDP
  command and makes no request: no interference with page tools, dialogs, navigation, hand-offs,
  `browser_route` mocks or HAR logs, and only tabs the views list are looked at. The UI checks it as
  page content: ≤ 32 KB decoded, type sniffed from the bytes (PNG, ICO, GIF, JPEG, WebP, SVG), SVG
  refused with scripts, event handlers, foreign content, entities or references outside itself;
  re-encoded as base64 and cached by URI (32 entries, entries of tabs no longer listed dropped). Tree
  views draw a `data:` icon as a CSS background image (the workbench CSP allows `data:` and `https:`;
  remote URIs are never passed). Waiting and paused tabs keep their warning icons.

- **Collapsing a session's tabs** (`ui/tabGroups.ts` plans, pure; `ui/tabGrouping.ts` runs it):
  there is no API for tab groups (microsoft/vscode#100335), and closing a browser editor destroys
  its page, so a collapsed session's tabs are *pinned*, one contiguous run per session. Verified on
  1.146: `workbench.action.pinEditor` / `unpinEditor` with the editor's resource
  (`vscode-browser:/<viewId>`) act on that tab in whichever group it is, without activating,
  focusing or reloading it; the tab bar updates before the command returns. Pinned tabs sort in pin
  order and an unpinned tab lands right after the pinned area, so pin / unpin in the right order also
  moves tabs. With an unknown resource the commands act on the **active** editor, so each operation
  first checks the tab is still open. Browser editors have no input in `window.tabGroups`; pin state
  and position are matched by label (title or host) like `columnOf`, and are "unknown" when two tabs
  share a label (such tabs are not pinned unless Copane pinned them). Only tabs Copane pinned are
  ever unpinned; a tab the user unpins leaves the group (`optedOut`); a tab with a pending hand-off
  is lifted out while it waits. State (collapsed session ids, pinned and opted-out **tab ids**) is
  in workspace state: tab ids, not view ids, because a tab an agent held at a window reload is
  replaced by a new one with a new view id (`replaceStuck`). For 20 s after activation a tab Copane
  pinned that is unpinned is taken as a pin the reload lost and pinned again. Ownership is
  `tabOwner` (the Agent Tabs panel's rule). A second `FileDecorationProvider` for the scheme adds
  "Collapsed with <session>'s tabs" to the tab's hover (VS Code joins decoration tooltips with " • ");
  a compact pinned tab shows no badge. The editor tab menu uses `resourceScheme == vscode-browser &&
  resourceFilename in copane.ui.collapsibleTabs` (view ids), verified to apply to browser editors.

## Terminal rules

- Agent terminals are real integrated terminals, named and colored after their session, visible to
  the user, who can type into them at any time.
- Commands run through shell integration, which gives output and exit codes. Output is returned as
  the text a person would see (control sequences interpreted, not just stripped).
- A long-running command returns after a timeout with what it printed so far and stays running; the
  agent reads more, waits, sends input or interrupts.
- A command that stops to be answered returns before the timeout (`stoppedForInput` in
  `terminal/activity.ts`, checked every 500 ms by `terminal_run` and `terminal_wait`): a request for
  a key, a choice, a login or a secret after 1.2 s of silence, a line that only reads like a question
  after 3 s, a full-screen program with a still screen after 2.5 s. Judged from the command's own
  output, and stricter than the wording of `assessActivity`: an answered question still on screen, a
  progress line or a prompt character alone do not count. A session is told of each stop once; a
  wait after that runs its full time (the user may be about to answer in the terminal).
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
- **After a restart of VS Code** a revived terminal has a new process, so it is matched to its
  remembered record by name (`matchPersisted`), and VS Code gives a revived terminal its name a
  moment after it opens (it opens as ""): while remembered terminals are unaccounted for, in the
  first minute after activation, `identify` waits up to 3 s for the name before taking a terminal
  for the user's own.
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
    src/extension/registration/  registering the MCP server with Claude Code, Codex and GitHub Copilot
    src/extension/vscodeChat/    opt-in MCP server definition for VS Code's own chat (this window only)
    contributes/*.json     per-module manifest fragments, merged into package.json by the build
    scripts/               dev host and MCP test client
    poc/                   the original feasibility probe (reference only)

## Registration

`registration/` registers the MCP server as `copane` with each agent's user configuration, one file
per agent: `claudeCode.ts` (`~/.claude.json`, through `claude mcp` when found, else a direct edit
under Claude Code's proper-lockfile lock), `codex.ts` (`~/.codex/config.toml`, text-level TOML edit)
and `copilot.ts` (`~/.copilot/mcp-config.json` or `$COPILOT_HOME/mcp-config.json`, read by the
Copilot CLI and by Copilot harness sessions in VS Code). Copilot's file is edited directly as JSONC
in one atomic read-modify-replace: `copilot mcp add` drops comments, and the CLI's own writer lock
(`.mcp-writer.lock`, an OS-level lock on an empty file) cannot be taken from Node; Copilot writes the
file only from its `mcp` commands, and the next check repairs a lost race. Copilot gives local servers
little more than `PATH`, so the entry passes `COPANE_INSTANCE` and `COPANE_SESSION` as
`${NAME:-}` references. Its comparison ignores what the user may customise (`tools`, `timeout`,
`cwd`, the default part of those references) and an update keeps those keys. `index.ts` enumerates
the agents (detection, settings `copane.registration.<agent>`, the dev-host guard that requires
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` inside the dev host's folder); `plan.ts` decides
from plain data what the startup check and Check and Repair do. In a remote window all of this
happens on the remote side, where the agents run.

## VS Code chat

`vscodeChat/` offers the server to VS Code's own MCP client through
`vscode.lm.registerMcpServerDefinitionProvider` (provider `copane.window`), opt-in with
`copane.vscodeChat.serverDefinition`. The definition (`definition.ts`, pure) is the launcher spec the
registration module publishes as `services.mcpServer`, plus `COPANE_INSTANCE` = this window; label
`copane`, no `cwd`, no `COPANE_SESSION`. The provider fires its change event on the setting and on
`mcpServer.onDidChange`; the instance id is the extension host's pid and never changes meanwhile.
Without the API (forks, old builds) it logs once and does nothing. From VS Code's source (main,
2026-11): under the Local harness the window's extension host spawns the server (so discovery matches
by `ancestor`); the Copilot harness gets extension definitions forwarded as `{type: local, command,
args, env}` under their label (`agentHostMcpServerSupport.ts`, `agentHostLocalCustomizations.ts`; a
`cwd` would be reported as not portable), and its Agent Host, shared by windows, spawns it, so
`COPANE_INSTANCE` routes it. VS Code's registry disables the lower-priority one of two servers with the
same label (`chat.mcp.collisionBehavior` "disable", default): an extension's (order 300) wins over
Copilot CLI discovery (400). VS Code's client calls itself `Visual Studio Code` (product name), which
`agentKind` maps to `other` ("Agent N", no usage notes: VS Code passes server instructions on). One
server process per window serves every chat there, so they share one session; VS Code sends
`_meta["vscode.conversationId"]` on `tools/call`, which could split them later. Verified in a dev host
(`test/e2e/vscode-chat.e2e.mjs`): VS Code asks the provider, and "MCP: Start Server" starts the
definition, which connects to this window. Not verified: a signed-in Copilot using it, the Copilot
harness, remote windows.

## Tool definitions cost context

Every tool definition (name, title, description, input schema, annotations) is sent to the model in
every conversation; Codex also appends the server instructions to each Copane tool it looks up.
`test/unit/tool-budget.test.ts` collects the tools the way the modules register them and fails when
the total, any one tool or the instructions grow past their budget. When it fails, shorten the wording
first: the first sentence says what the tool is for; a parameter is described only where its name and
type do not say it; guidance shared by many tools goes once into `core/instructions.ts` (Claude Code
cuts the server's instructions at 4096 characters). A new module that registers tools must be added to
that test. `scripts/measure-tokens.mjs` measures the same list, and result sizes, on a dev host.
The same test measures the `core` profile (`copane.tools.profile`); a tool used only for specialised
work belongs in `CORE_PROFILE_EXCLUDES` (`core/toolSelection.ts`).

## Getting started

`contributes/walkthrough.json` is the getting-started walkthrough; `registration/setup.ts` decides the
setup state (browser, agents, a session seen) from plain data and `registration/walkthrough.ts`
publishes it as `copane.setup.*` context keys and checks the steps off with VS Code's
`welcome.markStepComplete` (VS Code ignores an `onContext` completion whose key was already true when
the walkthrough registered). The Sessions view's welcome content uses the same keys. Walkthrough SVGs
use theme colors as presentation attributes (`fill="var(--vscode-foreground, #3b3b3b)"`): the
webview that shows them blocks `<style>`.
