import type { BridgeServices } from './services';

/** A sentence, or one that depends on which tools are on (undefined: leave it out). */
type Sentence = string | ((on: (tool: string) => boolean) => string | undefined);

const TOOL_NAME = /\b(?:browser|terminal|session)_[a-z_]+/g;

/**
 * MCP `instructions` for the agent. Keep it short: it is part of every conversation's context.
 * `enabled` says which tools the agent has (the user's `copane.tools.*` settings): a sentence that
 * names a tool that is off is adapted or left out, so the agent is never pointed at a missing tool.
 */
export function buildInstructions(services: BridgeServices, enabled: (tool: string) => boolean = () => true): string {
  const browser = services.browser.available;
  const paragraph = (prefix: string, sentences: Sentence[]): string | undefined => {
    const kept = sentences
      .map(s => (typeof s === 'string' ? s : s(enabled)))
      .filter((s): s is string => !!s && (s.match(TOOL_NAME) ?? []).every(enabled));
    return kept.length ? `${prefix}${kept.join(' ')}` : undefined;
  };
  const lines: Array<string | undefined> = [
    browser
      ? 'These tools work in the VS Code window you run in: its integrated browser tabs and terminals, which the user sees and can take over at any time.'
      : 'These tools work in the VS Code window you run in: its integrated terminals, which the user sees and can take over at any time.',
    paragraph('', ['When you start a task, name your session with session_set_title so the user can tell your terminals and tabs apart.']),
  ];
  if (browser) {
    lines.push(
      paragraph('Browser: ', [
        'tools act on your current tab (the one you last opened or selected) unless you pass `tab` (ids like "tab-1").',
        'Open your own tabs with browser_open.',
        'Using a tab the user opened asks them first; if they decline or pause a tab, do not retry: use your own tab or ask in chat.',
        'A tab another session drives can be read but not acted on.',
        'When you are done driving a tab, call browser_tab {"action":"release"}.',
      ]),
      paragraph('Pages: ', [
        'browser_snapshot gives refs (e.g. "e12") for the action tools; its mode "text" is cheapest for reading, and find locates something on a long page.',
        'Action results say what the action did (navigation, dialogs, console errors, failed requests, new tabs, downloads with their saved path) and which elements changed, with refs, so take a new snapshot only when a ref you need is reported changed or gone.',
        on => {
          const debugging = ['browser_console_messages', 'browser_network_requests (onlyNew)'].filter(t => on(t.replace(/ .*/, '')));
          const uses = [
            'browser_wait_for for content that loads later',
            'browser_screenshot only for visual layout',
            debugging.length ? `${debugging.join(' and ')} when debugging` : '',
          ].filter(u => u && (u.match(TOOL_NAME) ?? []).every(on));
          return uses.length ? `Use ${uses.length > 1 ? `${uses.slice(0, -1).join(', ')}, and ${uses.at(-1)}` : uses[0]}.` : undefined;
        },
        'If a site asks for a login, the user is asked, not you; if they decline, do not retry.',
        "When a page needs the user's own sign-in (SSO, MFA), a captcha or a choice only they can make, call browser_request_user_input; never ask for their password.",
        on => {
          const changing = ['browser_emulate', 'browser_route (mock requests)'].filter(t => on(t.replace(/ .*/, '')));
          if (changing.length === 2) return `${changing.join(' and ')} change the user's tab too: undo them when done.`;
          return changing.length ? `${changing[0]} changes the user's tab too: undo it when done.` : undefined;
        },
      ]),
    );
  }
  lines.push(
    paragraph('Terminals: ', [
      'tools act on your current terminal unless you pass `terminal` (ids like "term-2").',
      on =>
        `For servers and watchers pass timeout_seconds 5-10: the command keeps running${on('terminal_wait') ? ', and terminal_wait with for_text tells you when it is ready' : ''}.`,
      'Answer a prompt with terminal_send only if you know the answer.',
      on =>
        on('terminal_request_user_input')
          ? 'For a password, token, 2FA code or login, call terminal_request_user_input and never ask for the secret in chat.'
          : 'Never ask for a password, token or 2FA code in chat.',
      "Using the user's or another session's terminal asks the user first.",
      'Output longer than max_chars (default 12000) keeps its start and end, and names the terminal_read call for the cut lines.',
    ]),
  );
  if (!browser) {
    lines.push(
      'The integrated browser is not enabled in this VS Code, so there are no browser_* tools. If the task needs a browser tab, ask the user to run the command "Copane: Enable Integrated Browser", then quit and start VS Code again (reloading the window is not enough); the browser tools are there after that.',
    );
  }
  return lines.filter((l): l is string => !!l).join('\n');
}
