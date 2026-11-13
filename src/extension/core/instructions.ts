import type { BridgeServices } from './services';

/** MCP `instructions` for the agent. Keep it short: it is part of every conversation's context. */
export function buildInstructions(services: BridgeServices): string {
  const lines = [
    'These tools work in the VS Code window you run in: its integrated browser tabs and terminals, which the user sees and can take over at any time.',

    'Browser: tools act on your current tab (the one you last opened or selected) unless you pass `tab` (ids like "tab-1"). Open your own tabs with browser_open. Using a tab the user opened asks them first; if they decline or pause a tab, do not retry: use your own tab or ask in chat. A tab another session drives can be read but not acted on. Call browser_release_tab when you are done driving a tab.',

    'Pages: browser_snapshot gives refs (e.g. "e12") for the action tools; its mode "text" is cheapest for reading, and find locates something on a long page. Action results say what the action did (navigation, dialogs, console errors, failed requests, new tabs) and which elements changed, with refs, so a new snapshot is rarely needed after one. If a ref is reported changed or gone, take a new snapshot. Use browser_wait_for for content that loads later, browser_screenshot only for visual layout, and browser_console_messages and browser_network_requests (onlyNew) when debugging.',

    'Terminals: tools act on your current terminal unless you pass `terminal` (ids like "term-2"). terminal_run runs commands in your own terminal. For servers and watchers pass timeout_seconds 5-10: the command keeps running, and terminal_wait with for_text tells you when it is ready. Answer a prompt with terminal_send only if you know the answer. For a password, token, 2FA code or login, call terminal_request_user_input and never ask for the secret in chat. Using the user\'s or another session\'s terminal asks the user first.',
  ];
  if (!services.browser.available) {
    lines.push('The integrated browser is not enabled in this VS Code yet, so browser_* tools fail until the user enables it (command "Copane: Enable Integrated Browser", then a restart). Terminal tools work.');
  }
  return lines.join('\n');
}
