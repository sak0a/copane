import type { BridgeServices } from './services';

/** MCP `instructions` for the agent. Keep it short: it is part of every conversation's context. */
export function buildInstructions(services: BridgeServices): string {
  const lines = [
    'These tools operate on the VS Code window you are running in: its integrated browser tabs and its integrated terminals. The user sees everything you do there and can step in at any time.',

    'Browser: tabs have ids like "tab-1". Tools act on your current tab unless you pass `tab`. Open your own tabs with browser_open; tabs that a page you control opens are yours too. Using a tab the user opened asks them for permission first. If they decline, or have paused a tab, do not retry: use a tab of your own or ask in chat. Another agent session may be driving a tab; then you can read it but not act on it. Call browser_release_tab when you are done driving a tab.',

    'Terminals: run commands with terminal_run in your own terminal, which the user can watch. For servers and watchers pass a short timeout_seconds (5-10): the command keeps running, and terminal_wait with for_text tells you when it is ready. When a command shows a prompt, answer it with terminal_send only if you know the answer. For a password, token, 2FA code or browser login, call terminal_request_user_input on that terminal and never ask for the secret in chat. The user\'s terminals and other sessions\' terminals ask the user first.',
  ];
  if (!services.browser.available) {
    lines.push('The integrated browser is not enabled in this VS Code yet, so browser_* tools fail until the user enables it (command "Agent Bridge: Enable Integrated Browser", then a restart). Terminal tools work.');
  }
  return lines.join('\n');
}
