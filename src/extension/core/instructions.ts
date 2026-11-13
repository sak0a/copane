import type { BridgeServices } from './services';

/** MCP `instructions` for the agent. Keep it short: it is part of every conversation's context. */
export function buildInstructions(services: BridgeServices): string {
  const lines = [
    'These tools operate on the VS Code window you are running in: its integrated browser tabs and its integrated terminals. The user sees everything you do there and can step in at any time.',
    'Browser: tabs have ids like "tab-1". Tools act on your current tab unless you pass `tab`. You may open your own tabs freely; using a tab the user opened asks them for permission first. Another agent session may hold a tab; then you can only read it.',
    'Terminals: use terminal_* for anything the user should watch or take part in (dev servers, logins, interactive CLIs). When a command needs the user (password, 2FA, browser login), call terminal_request_user_input instead of guessing or asking for secrets in chat.',
  ];
  if (!services.browser.available) {
    lines.push('The integrated browser is not enabled in this VS Code yet, so browser_* tools fail until the user enables it (the extension shows them how).');
  }
  return lines.join('\n');
}
