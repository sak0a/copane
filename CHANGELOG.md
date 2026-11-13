# Changelog

## 0.1.0 (unreleased)

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
