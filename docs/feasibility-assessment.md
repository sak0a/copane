# Feasibility Assessment — Native VS Code Browser & Terminal for AI Agents

Date: 2026-11-13 · Tested on: VS Code 1.145.2 → 1.146.0 stable, macOS arm64 · Phase A of the handoff

## TL;DR

**The core requirement is feasible on stable VS Code.** An extension can enumerate integrated-browser
tabs it did not open, attach to them via CDP, and drive them (click/type/eval/screenshot/navigate) while
the user sees the same tab. The catch: it uses the **proposed `browser` API**, so the user must enable it
once via `argv.json` (`"enable-proposed-api": ["<publisher>.<ext>"]`). Terminals need only stable APIs.

Recommended route: **build on `thimo/vscode-integrated-browser-mcp` (MIT, active)** and add a terminal
bridge, durable tab IDs, and a consent/lease model for user-owned tabs.

## Verified by experiment (probe in `poc/`)

| # | Question | Result |
|---|---|---|
| 1 | Proposed `browser` API usable in **stable** VS Code? | ✅ Yes, with `--enable-proposed-api=<id>` (or `argv.json`). Without it the API throws. |
| 2 | Tabs opened by VS Code itself (not via `openBrowserTab`) visible to the extension? | ✅ Yes. Opened via the built-in `workbench.action.browser.open` command (same action as the palette / title-bar globe); `window.browserTabs` lists them and `onDidOpenBrowserTab` fires. A true mouse click on the globe was not possible during the test (user was at the desk). |
| 3 | Drive an existing tab via CDP, visible to the user? | ✅ Clicked 5× and typed into the user-visible tab; desktop screenshot of the VS Code window showed `Clicks: 5` and the typed text. |
| 4 | Operate a **background** (non-active) tab? | ✅ Click, type, eval, `Page.captureScreenshot` all worked on an inactive tab. |
| 5 | Multi-tab isolation | ✅ Each `startCDPSession()` sees only its own page target; actions on tab 1 did not affect tab 2. |
| 6 | Identity across cross-origin navigation | ✅ Same `BrowserTab` object, same CDP session keeps working. |
| 7 | User-initiated reload | ✅ Session survives; page JS state resets (expected). |
| 8 | Tab closed | ⚠️ `onDidCloseBrowserTab` fires, but the CDP session's own `onDidClose` did **not**; further sends fail with `Session not found`. Invalidate sessions from the tab-close event. |
| 9 | Multiple windows | ✅/⚠️ The API is **scoped per window**: each window's extension host sees only its own tabs. A gateway must route each request to the owning window. |
| 10 | Two agents on the same tab simultaneously | ⚠️ Both CDP sessions attach and both can mutate. VS Code enforces **no exclusivity**, so leases must live in our bridge. |
| 11 | Recovery after full VS Code restart | ✅ Restored tabs are present in `browserTabs` at activation (page reloads; in-memory ids reset). |
| 12 | Durable tab ID | ✅ CDP `Target.getTargets` exposes `vscodeBrowserViewId` (UUID), **stable across a full restart**. Undocumented field, so it needs a fallback. |
| 13 | Create real terminal + shell integration | ✅ `createTerminal` → shell integration activates (zsh) within seconds. |
| 14 | Command output + exit code | ✅ `shellIntegration.executeCommand` + `execution.read()` + `onDidEndTerminalShellExecution` → exit 0/1 and output. Output contains OSC 633 / ANSI sequences, which need stripping. |
| 15 | Interactive input by a human | ✅ `read -s` prompt blocked until input arrived (sent separately), then completed with exit 0. The agent never saw the secret, only `received 12 chars`. Real keyboard typing was not exercised (desktop busy). |
| 16 | User-created terminals visible | ✅ `window.terminals` includes them; the bridge can label agent-owned vs user-owned. |

## Verified by source reading (VS Code `main`, 2026-11-12)

- API: `src/vscode-dts/vscode.proposed.browser.d.ts` — `browserTabs`, `activeBrowserTab`, open/close/active/state
  events, `openBrowserTab(url, {viewColumn, preserveFocus, background})`, `BrowserTab.startCDPSession()`, `close()`.
  Tracked upstream in microsoft/vscode#300319. The shape can change between releases.
- **WSL / remote:** the browser always runs on the UI side (Windows). `extHostBrowserTunnelProxy.ts` routes browser
  traffic through the window's remote connection (WSL, Dev Containers, Codespaces, Tunnels), so `localhost:3000`
  in a WSL window reaches the WSL server. The API is wired in `extHost.api.impl.ts` for any extension host, so
  a workspace-side (WSL) extension can drive tabs. **Not tested — needs a Windows machine.**
- Copilot's own browser tools (`open_browser_page`, `read_page`, `click_element`, `run_playwright_code` …) are
  internal LM tools gated by `workbench.browser.enableChatTools` and a **per-page "shared with agent"** state
  tied to a Copilot chat session. The `browser` tool set is already marked `deprecated: true`. They're not a good foundation.

## Existing implementations

| Project | Approach | Status | Verdict |
|---|---|---|---|
| **thimo/vscode-integrated-browser-mcp** | Proposed `browser` API + CDP; falls back to a js-debug session (single tab) without the flag | MIT, v0.9.1, pushed 2026-10-16, 18★, 0 open issues, Marketplace | **Best base.** Already has: multi-tab, `allowAllExistingTabs` (opt-in control of user tabs), per-MCP-session tab ownership, a single-tab lease on the fallback path, multi-window routing (instance files + cwd match, `matchedBy` reporting), unix socket with owner-only perms, auto-registration in `~/.claude.json` and Codex, ~25 tools. |
| TheoZhao/vscode-browser-bridge | `vscode.lm.invokeTool` on Copilot's internal browser tools | MIT, v0.2.9, last update 2026-06-27, 526 installs | Stable-API only, but inherits Copilot's per-page sharing, confirmations and the deprecated tool set. Fragile. |
| mercurial/arc-terminal | Terminal MCP | 84 installs, source repo is private (`ssh://…m16.local`) | Cannot be forked. The terminal side is easy on stable APIs anyway (see #13–16). |

Note: thimo's code has contradictory comments about cross-window tab visibility ("across all windows" vs
"per-window"). Experiment #9 shows **per-window** on 1.146.

## Recommended architecture (delta on top of thimo)

1. **Keep** thimo's transport (socket per window + instance registry + cwd matching) and MCP server.
2. **Durable tab IDs:** key tabs by `vscodeBrowserViewId`, with the in-memory id as fallback; expose `windowId` + `workspace` in every tab listing.
3. **Control model for user tabs:** replace the global `allowAllExistingTabs` boolean with a per-tab `browser_request_control` → VS Code notification ("Claude wants to control *localhost:3000* — Allow / Allow for session / Deny"). Add time-bounded leases for **all** tabs, not only the fallback path (finding #10), and read-only access while another agent holds the lease.
4. **Terminal bridge** in the same extension (stable APIs): `terminal_create/list/execute/send_input/get_output/wait_for_exit/request_user_input/close`. Strip OSC 633/ANSI. Agent-owned vs user-owned flag; writing into user-owned terminals requires consent. `terminal_request_user_input` shows the terminal and a notification, then resolves on `onDidEndTerminalShellExecution`.
5. **WSL:** run the extension workspace-side (default `extensionKind`) so the instance registry, socket, MCP server and Claude Code all live in the same OS (WSL home), while browser calls go to the Windows UI through the main thread. Verify on Windows.
6. **Proposed-API UX:** detect the missing flag and offer a one-click "Enable" that edits `argv.json` and tells the user to fully restart. Keep thimo's fallback path.

## Revised effort (one developer, AI-assisted, building on thimo)

| Scope | Estimate |
|---|---|
| Terminal bridge (tools, output cleaning, interactive wait, consent) | 2–4 days |
| Durable IDs + per-tab consent + leases for all tabs | 3–5 days |
| WSL / Windows validation and fixes (needs a Windows box) | 2–4 days |
| Hardening: recovery, tests, docs | 1 week |
| **Usable v1** | **~2–3 weeks** (down from 6–10, because thimo already covers most of the browser side) |

## Risks

- **Proposed API instability** (#300319): the shape may change; Marketplace users must enable it via `argv.json`.
- `vscodeBrowserViewId` is an undocumented CDP extension.
- CDP has no exclusivity, so a buggy or malicious second client can bypass leases. Leases are cooperative between our own MCP sessions only.
- WSL behaviour is source-verified only.

## Not yet tested

- A true mouse-driven tab open and real keyboard input in the terminal (the desktop was in use during testing).
- Windows + WSL (no Windows machine available here).
- thimo's extension itself was reviewed but not installed/run in this pass.
