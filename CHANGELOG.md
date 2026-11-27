# Changelog

## Unreleased

VS Code 1.148:

- **Logins.** VS Code 1.148 shows a sign-in dialog of its own when a page asks for a login. A tab
  an agent opened straight onto such a page sat behind that dialog, and the agent's calls on it got
  no answer. Copane now loads the page after it has attached to the new tab, so you are asked the
  way Copane asks, in any tab an agent drives, and the agent is told what happened.
- With `copane.browser.loginPrompts` off, `browser_open` and `browser_navigate` say that the page
  may be waiting at VS Code's sign-in dialog, instead of "the browser did not answer".

## 0.4.1

Fixes in the browser tools.

- A page that navigates while a tool is still waiting on it no longer drops the tab's connection:
  the tool says the page navigated, and the next call works without reconnecting.
- The page indicator (Take over, Resume, Done) could stay hidden when a screenshot was cancelled
  while it was being taken.
- `browser_wait_for` stops as soon as you take the tab over, instead of reading the page once more.
- A console message that repeats is seen as new again: by `browser_check_change` (a hot update that
  prints the same line as the last one), in the console list with `onlyNew`, and in what an action
  reports.
- `browser_screenshot` of a tab that was never shown and emulates a device larger than 1024×768 gave
  the wrong factor for click coordinates; it now says the image is the top-left of the viewport.

## 0.4.0

GitHub Copilot joins Claude Code and Codex, the tool list is smaller and configurable, and agents can
walk a page by keyboard, find the source of an element and check what a code change did to a page.
**Breaking:** several tool names changed (see "Fewer tools"); update permission allowlists.

- **Site icons.** The Sessions view and the Agent Tabs panel show each tab's site icon (the one
  VS Code's browser already shows; size-limited, unsafe SVGs refused, nothing extra loaded).
  Setting `copane.ui.favicons` turns it off.
- **Collapse a session's browser tabs** in the editor tab bar: they are pinned together as compact
  site icons and new ones join them; expand, "Show Only This Session's Tabs", "Group Browser Tabs
  by Agent Session" and "Expand All" from the Sessions view, the tab's context menu or the palette.
  Survives a window reload; asks once before setting `workbench.editor.pinnedTabSizing`
  (`copane.ui.collapsedTabSizing`). VS Code has no real tab groups, so there is no group label and
  a collapsed tab is still one 28 px icon.
- **Fewer tools, smaller tool list. Breaking: tool names changed, update permission allowlists.**
  `browser_select_tab`, `browser_show_tab`, `browser_release_tab` and `browser_close_tab` are now
  one tool, `browser_tab` with `action` (`select`, `show`, `release`, `close`); `browser_list_tabs`
  stays a separate read-only tool. `browser_history` is now `browser_navigate` with `action`
  (`back`, `forward`, `reload`) instead of `url`. `terminal_interrupt` is now `terminal_send` with
  keys `["Ctrl+C"]`, which still waits for the command to end and says whether it did; it is
  refused while the user holds the terminal. The old names still work for this release (not listed;
  each result names the new call) and will be removed in the next one. Allowlists such as
  `mcp__copane__browser_close_tab` need the new names, and `copane.tools.disabled` entries naming
  old tools apply only to calls made under the old name. 45 → 40 tools; the `core` profile has 28.
- **Tool settings.** `copane.tools.profile` (`core` leaves out the specialised tools, about a third
  fewer characters) and `copane.tools.disabled` choose which tools agents get;
  `copane.usageNotesInResults` turns off the usage notes Copilot sessions get with their first
  result. A tool call with an unknown argument is refused with the valid names instead of the
  argument being dropped silently.
- **Smaller results by default.** Terminal output over 12,000 characters (was 20,000) keeps its
  start and its end and names the `terminal_read` call for the cut lines; polling a running command
  repeats less. `browser_screenshot` defaults to 1280 px / 0.8 MP (`detail: "high"` for the previous
  size), says how image pixels map to page coordinates for every kind of shot, and takes `path` to
  also save the image inside the project for agents whose client does not pass images on. Console
  and network lists cover the current page and its redirects (`allPages` for earlier ones). Audit
  caveats and the sign-in hint are given in full once per session.
- **VS Code's own chat.** Opt-in `copane.vscodeChat.serverDefinition` offers Copane to VS Code chat
  as a server that always uses this window (experimental, not verified with a signed-in Copilot).
  Each chat conversation of VS Code's MCP client gets its own Copane session.
- **GitHub Copilot** is a third agent Copane registers with: the `copane` entry in
  `~/.copilot/mcp-config.json` (or `$COPILOT_HOME`), which the Copilot CLI and Copilot chat in VS
  Code read. Edited in place keeping comments, other servers and your own `tools` filter; passes
  `COPANE_INSTANCE`/`COPANE_SESSION` through as `${NAME:-}` references. Setting
  `copane.registration.copilot`; detected by `~/.copilot`, `copilot` on the PATH or the Copilot Chat
  extension. Status reports a server turned off with `copilot mcp disable`.
- **Copilot sessions** are labelled "Copilot 1" (badge `G1`), keep their Copane session across
  `copilot --resume`, and get Copane's usage notes once with their first tool result, because the
  Copilot CLI does not pass MCP server instructions to the model by default. An agent running in a
  git worktree finds the window that has the main checkout open.
- **Fewer tokens.** Without the integrated browser no `browser_*` tools are listed (12 tools instead
  of 40). Reading a page again with `browser_snapshot` returns only what changed (`offset: 0` for
  the whole page). Full-screen terminal programs no longer re-send old scrollback and results show
  their screen; repeated and blank terminal lines are collapsed with a count. Network lists print
  paths of the page's own origin, request details merge duplicate headers and leave out routine
  ones, and large JSON from `browser_evaluate` and request bodies is compact. Shorter instructions
  and schemas.
- **Keyboard walk** (`browser_audit` with `type: "keyboard"`): presses Tab through the page and
  reports the focus order, focus that is not visible, keyboard traps, controls Tab never reaches, a
  missing or broken skip link and focus jumps, each with its WCAG criterion, element ref and fix.
  Follows focus into shadow DOM and frames; focus, scroll and selection are restored.
- **Element to source** (`browser_inspect`): the components that render an element, innermost
  first, with workspace file:line, for React, Vue 2/3 and Svelte development builds and inspector
  plugin attributes; bundled locations are resolved through source maps.
- **Check after a code change** (`browser_check_change`): a baseline before editing, then only what
  changed once the hot update or reload settled: new errors with source locations, failed requests,
  navigation or crash, changed screenshot regions with the after-screenshot. Works with Vite and
  webpack hot updates and plain reloads.
- While a tab was being replaced after a window reload, the tab list could briefly show the
  replacement as an extra tab with a new id.

## 0.3.0

Agents can hand a tab to you, keep separate logins per environment, audit pages for accessibility
and performance, and record and throttle network traffic.

- **HAR export**: `browser_network_requests` with `har` writes a tab's requests, iframes from
  other sites included, as a HAR 1.2 file for Chrome DevTools, Firefox or any HAR viewer. Cookie
  values, tokens and other secret-looking values are masked by default; response bodies are
  included on request.
- **Slow network, offline, slow CPU**: `browser_emulate` with `network` (offline, 3g, slow-4g,
  fast-4g or your own numbers) and `cpu` (a slowdown factor). It reaches iframes from other sites,
  shows on the tab in the views, and ends when the agent releases the tab or you end the
  emulation. `browser_audit` says when its performance numbers were measured under throttling.
- **Hand a browser tab to you** (`browser_request_user_input`): for single sign-on, MFA, captchas,
  consent screens and decisions only you can make. The tab comes to the front with the agent's
  request, the agent cannot read or use it meanwhile, and it gets the tab back when you click
  **Done** or **Won't Do**, or when a condition it named holds (an address, a text on the page).
- **Login profiles** (`browser_profiles`, `browser_open` with `profile`): separate login stores, so
  one window can be signed in to the same site as different accounts (dev, test, prod). You can
  choose a profile per session or per tab, or give every agent session a private one with
  `copane.browser.agentLoginStore`. Profiles live in memory until VS Code quits.
- **Accessibility and performance audits** (`browser_audit`): axe-core findings with their WCAG
  criterion and level, element refs and fixes, WCAG failures first; and a performance report (load
  timing, Web Vitals, slowest and largest requests, long tasks, render-blocking resources).
- **Playwright test export** (`browser_export_test`): what the agent did in a tab as a Playwright
  test with role and label locators.
- GitHub Actions: checks on Linux, macOS and Windows, end-to-end suites on Linux, releases built
  from version tags, and a nightly run against VS Code Insiders.
- **Terminal names stay true after a window reload.** Sessions get their label and color back when
  they reconnect, in whatever order; a new session no longer takes a returning session's number. A
  session that comes back under another label gets its terminals renamed when they are active.
- **Terminals cost far less.** Your own terminals keep only the last 64 kB of output until you let
  an agent use one (it then sees the screen and recent output); before, each kept a full emulator
  (about 6 MB for a terminal that printed a lot). Closed terminals are released at once. Very fast
  output (a huge build log, `yes`) is parsed at most about a third of the time, skipping lines that
  would scroll out anyway, so the extension host stays responsive.
- **Remote windows (WSL, SSH, containers): downloads reach the agent.** The browser saves on your
  computer, Copane copies the file to the agent downloads folder on the remote side and gives the
  agent that path. **Enable Integrated Browser** changes your local argv.json directly from a remote
  window. No second extension is needed.
- **Get Started walkthrough**: opens once after installing (never for someone already set up) and
  from **Copane: Get Started** or the Copane view. Its steps (enable the browser, turn Copane on for
  Claude Code and Codex, try it, see sessions) are checked off, and un-checked, from the real state;
  in a remote window and in editors without the integrated browser it says what applies there.
- In an editor without VS Code's integrated browser, the status report, the Copane views and
  **Enable Integrated Browser** say that the browser tools are not available there instead of
  offering a fix; the terminal tools work as before.
- Agents started in a folder reached through a symbolic link (macOS `/tmp`, linked project folders)
  find their window by its folder again. Codex passes such resolved paths.
- Shorter tool definitions (25,366 → 24,153 characters) and a test that keeps them within budget.
- README: installing, other editors and Open VSX, and how Codex treats Copane's tools.
- **Request mocking and login prompts reach into iframes from other sites**, nested ones and frames
  added later included, from a frame's very first request on.
- **Tabs keep their ids across a window reload** also when no agent has used them yet. Tabs that
  cannot be told apart (two tabs on the same page) get new ids, and their old ids fail with a clear
  message instead of reaching another tab.
- **Questions about a browser tab wait in the status bar** instead of a notification, because VS
  Code pauses a browser view while a notification covers it. Click the item (or run "Copane: Answer
  Agent Question") to answer in a dialog.

Fixed:

- Text typed into password, one-time-code and card fields is no longer repeated in the result of
  `browser_type` and `browser_fill_form` ("Typed 12 characters (not shown: a password or code
  field)") or in an exported test.
- A tab an agent was controlling could no longer load anything after a window reload. Such a tab
  is now replaced after the reload by a new one at the same address, in the same login profile,
  under the same tab id.
- **Show Agent Session** sometimes opened the Sessions view without selecting the session's row.
- A tab an agent opened right before a window reload came back as "opened by the user".
- In bash (the default shell on Linux, and Git Bash), commands that chain several commands
  (`a && b`, `a; b`, `a | b`) or use an alias (`ls` is `ls --color=auto` on Ubuntu) returned
  "(no output)" after a 2.5 s wait. They return their output again.
- The first command in a new bash terminal could be taken for a stray Ctrl+C and return at once
  without its output.
- A finished command no longer looks like it runs forever when VS Code misses its end (seen with
  bash when the command line wraps): the shell's own end marker finishes it.
- On Windows, a downloaded file whose suggested name contains a colon (`a:b.txt`) is saved as
  `a_b.txt`, as on macOS and Linux, instead of losing the part before the colon.

## 0.2.1

- License changed from MIT to the PolyForm Shield License 1.0.0: use, change and share it freely,
  including at work, but do not offer a competing product. Versions up to 0.2.0 stay MIT.
- The package includes THIRD_PARTY_NOTICES.md with the licenses of the bundled open-source packages.

## 0.2.0

Agents use far fewer tokens for the same work, and reach more of a page.

- **Leaner snapshots.** Element refs only on what an agent can act on, link targets left out unless
  asked for (`urls: true`), table rows on one line. `browser_snapshot` gains `mode: "text"` (read a
  page as text), `find` (only matching elements), and `offset` (continue a cut snapshot).
- **Action results say what changed on the page**, so a new snapshot is rarely needed after a click.
- **Tool definitions are about 40% smaller.**
- **Iframes from other sites** are read and used like any other element.
- **Login prompts** for sites and proxies that ask for a user name and password (Basic, Digest,
  NTLM); the agent never sees what you type. Optional saving in VS Code's secret storage.
- **Downloads**: files an agent downloads are saved and their path reported (`browser_downloads`).
- **Device emulation** (`browser_emulate`) and **request mocking** (`browser_route`).
- **Certificate errors** ask once per host, with a trusted-hosts setting.
- The session indicator in a page can be dragged to any corner.
- **Agent Tabs** view in the bottom panel; **Check and Repair Setup**, **Turn On** and **Turn Off**
  commands; registration can no longer lose its entry during an update.

Changed for agents:

- Removed `browser_select_option`: use `browser_fill_form` with `{ ref, value }`.
- Removed `browser_network_request`: use `browser_network_requests` with `id`.
- `browser_open` waits for the page to load and reports its title and status.
- The snapshot format changed as described above.

Fixed:

- A navigation no longer reports console errors of the page being left.
- Clicks no longer fail as "covered" when the bottom panel shrinks the browser area.

## 0.1.1

Publisher id is `saka`; the extension id is `saka.copane`.

## 0.1.0

First version.

- MCP server named `copane` that gives Claude Code, Codex and other MCP agents the VS Code window
  they run in: its integrated browser tabs and integrated terminals, shared with the user.
- Several agent sessions per window and several windows at once; each session has its own label
  and color, and finds its own window (Claude Code chats, `claude` / `codex` in a terminal, agents
  started outside VS Code).
- One-time, consent-based registration with Claude Code (`~/.claude.json`, user scope) and Codex
  (`~/.codex/config.toml`); `Copane: Unregister from Claude Code and Codex` removes it again.
- `Copane: Enable Integrated Browser` turns on VS Code's proposed browser API in `argv.json`.
- `Copane: Show Status` explains what is and is not working, with a self-test.
- The MCP server reconnects after a window reload and keeps the agent's session.
