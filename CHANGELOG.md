# Changelog

## Unreleased

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
