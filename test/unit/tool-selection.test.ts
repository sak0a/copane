// Which tools the user's settings `copane.tools.profile` and `copane.tools.disabled` leave agents, the
// message of a refused call, and the instructions that go with it.
import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../../src/extension/core/instructions';
import { alwaysEnabled, CORE_PROFILE_EXCLUDES, disabledBy, disabledToolMessage, isToolEnabled, toolProfile } from '../../src/extension/core/toolSelection';

const TOOL_NAME = /\b(?:browser|terminal|session)_[a-z_]+/g;

describe('tool selection', () => {
  it('turns nothing off by default, and an unknown profile is full', () => {
    for (const selection of [{}, { profile: 'full' }, { profile: 'nonsense' }, { profile: undefined, disabled: undefined }]) {
      expect(toolProfile(selection)).toBe('full');
      for (const name of [...CORE_PROFILE_EXCLUDES.keys(), 'browser_click', 'terminal_run']) expect(isToolEnabled(selection, name)).toBe(true);
    }
  });

  it('the core profile leaves out its list and nothing else', () => {
    const core = { profile: 'core' };
    for (const name of CORE_PROFILE_EXCLUDES.keys()) expect(disabledBy(core, name)).toBe('copane.tools.profile');
    for (const name of ['browser_open', 'browser_click', 'browser_handle_dialog', 'terminal_run', 'session_set_title']) expect(isToolEnabled(core, name)).toBe(true);
  });

  it('disabled names apply on top of the profile; unknown or malformed entries are ignored', () => {
    const selection = { profile: 'core', disabled: ['terminal_close', ' browser_click ', 'no_such_tool', 42, null, { name: 'x' }] };
    expect(disabledBy(selection, 'terminal_close')).toBe('copane.tools.disabled');
    expect(disabledBy(selection, 'browser_click')).toBe('copane.tools.disabled');
    expect(disabledBy(selection, 'browser_emulate')).toBe('copane.tools.profile');
    expect(isToolEnabled(selection, 'terminal_run')).toBe(true);
    expect(isToolEnabled({ disabled: 'browser_click' as unknown as string[] }, 'browser_click')).toBe(true);
  });

  it('never turns off the tools an agent recovers with, nor debug tools', () => {
    const selection = { profile: 'core', disabled: ['window_status', 'window_select', 'debug_vscode_command'] };
    for (const name of ['window_status', 'window_select', 'debug_vscode_command', 'debug_answer_prompts']) {
      expect(alwaysEnabled(name)).toBe(true);
      expect(isToolEnabled(selection, name)).toBe(true);
    }
  });

  it('a refused call says which setting turned the tool off and what to do instead', () => {
    expect(disabledToolMessage({ profile: 'core' }, 'terminal_interrupt')).toBe(
      'terminal_interrupt is turned off in this VS Code window by the user\'s setting "copane.tools.profile": "core". Use terminal_send with keys ["Ctrl+C"].',
    );
    expect(disabledToolMessage({ disabled: ['browser_route'] }, 'browser_route')).toBe(
      'browser_route is turned off in this VS Code window by the user\'s setting "copane.tools.disabled". Continue without it; if the task cannot be done without it, tell the user.',
    );
    // An alternative that is itself off is not suggested.
    expect(disabledToolMessage({ profile: 'core', disabled: ['terminal_send'] }, 'terminal_interrupt')).not.toContain('terminal_send');
    // It never tells the agent to change the setting itself.
    for (const name of CORE_PROFILE_EXCLUDES.keys()) expect(disabledToolMessage({ profile: 'core' }, name).replace(name, '')).not.toMatch(/setting.*(change|enable)|turn (it )?on/i);
  });
});

describe('instructions under a selection', () => {
  const services = (available: boolean) => ({ browser: { available } }) as any;

  it('leave out or adapt every sentence that names a tool that is off', () => {
    const full = buildInstructions(services(true));
    const named = [...new Set(full.match(TOOL_NAME))];
    expect(named.length).toBeGreaterThan(10);
    for (const name of named) {
      const text = buildInstructions(services(true), tool => tool !== name);
      expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(text.length, name).toBeLessThan(full.length);
      // The rest stays: every other tool named before is still named.
      for (const other of named.filter(n => n !== name && n !== 'browser_route' && n !== 'browser_emulate')) expect(text, `${name} took ${other}`).toContain(other);
    }
  });

  it('keep the essentials when the tools they name are off', () => {
    const text = buildInstructions(services(true), tool => !['terminal_wait', 'terminal_request_user_input', 'browser_emulate', 'browser_screenshot'].includes(tool));
    expect(text).toContain('For servers and watchers pass timeout_seconds 5-10: the command keeps running.');
    expect(text).toContain('Never ask for a password, token or 2FA code in chat.');
    expect(text).toContain("browser_route (mock requests) changes the user's tab too: undo it when done.");
    expect(text).toContain('Use browser_wait_for for content that loads later, and browser_console_messages and browser_network_requests (onlyNew) when debugging.');
  });

  it('drop a whole paragraph only when nothing of it is left', () => {
    const noBrowser = buildInstructions(services(true), tool => !tool.startsWith('browser_'));
    expect(noBrowser).toMatch(/^Browser: tools act on your current tab/m);
    expect(noBrowser).not.toMatch(/\bbrowser_[a-z]/);
    expect(noBrowser).toMatch(/^Terminals: /m);
  });
});
