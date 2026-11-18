// Old names of merged tools (core/toolAliases.ts): each maps to the new call. Remove with the aliases.
import { describe, expect, it } from 'vitest';
import { resolveToolAlias, TOOL_ALIASES, withAliasNote } from '../../src/extension/core/toolAliases';
import { tabActionProblem } from '../../src/extension/browser/tabTools';
import { navigateProblem } from '../../src/extension/browser/page/navigationTools';

describe('tool aliases', () => {
  it('maps every old name to the new call with the same arguments', () => {
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ['browser_select_tab', { tab: 'tab-3' }, 'browser_tab', { action: 'select', tab: 'tab-3' }],
      ['browser_show_tab', {}, 'browser_tab', { action: 'show' }],
      ['browser_release_tab', { all: true }, 'browser_tab', { action: 'release', all: true }],
      ['browser_release_tab', { tab: 'tab-1' }, 'browser_tab', { action: 'release', tab: 'tab-1' }],
      ['browser_close_tab', { tab: 'tab-2' }, 'browser_tab', { action: 'close', tab: 'tab-2' }],
      ['browser_history', { action: 'reload', ignoreCache: true, waitUntil: 'load', timeout: 5, tab: 'tab-1' }, 'browser_navigate', { action: 'reload', ignoreCache: true, waitUntil: 'load', timeout: 5, tab: 'tab-1' }],
      ['terminal_interrupt', { terminal: 'term-2' }, 'terminal_send', { terminal: 'term-2', keys: ['Ctrl+C'] }],
      ['terminal_interrupt', undefined as unknown as Record<string, unknown>, 'terminal_send', { keys: ['Ctrl+C'] }],
    ];
    for (const [old, args, name, mapped] of cases) {
      const call = resolveToolAlias(old, args);
      expect(call, old).toMatchObject({ name, args: mapped });
    }
    expect(new Set(cases.map(c => c[0]))).toEqual(new Set(TOOL_ALIASES.keys()));
  });

  it('every mapped call is valid for the new tool', () => {
    for (const [old, args] of [['browser_select_tab', { tab: 'tab-3' }], ['browser_show_tab', {}], ['browser_release_tab', { all: true }], ['browser_close_tab', {}]] as const) {
      const call = resolveToolAlias(old, args)!;
      expect('args' in call && tabActionProblem(call.args as any), old).toBeFalsy();
    }
    for (const action of ['back', 'forward', 'reload']) {
      const call = resolveToolAlias('browser_history', { action })!;
      expect('args' in call && navigateProblem(call.args as any)).toBeFalsy();
    }
  });

  it('names the new call in a note, with the history action', () => {
    expect(resolveToolAlias('browser_close_tab', { tab: 'tab-2' })!.note).toBe('(browser_close_tab is now browser_tab {"action":"close"}: call that from now on; the old name will be removed.)');
    expect(resolveToolAlias('browser_history', { action: 'back' })!.note).toBe('(browser_history is now browser_navigate {"action":"back"}: call that from now on; the old name will be removed.)');
  });

  it('refuses arguments the old tool did not take, and keeps _meta', () => {
    const wrong = resolveToolAlias('browser_close_tab', { tab: 'tab-2', all: true });
    expect(wrong).toMatchObject({ name: 'browser_tab', error: expect.stringContaining('browser_close_tab has no argument "all"; nothing was done.') });
    expect(resolveToolAlias('terminal_interrupt', { _meta: { x: 1 } })).toMatchObject({ args: { _meta: { x: 1 }, keys: ['Ctrl+C'] } });
  });

  it('is not an alias for a current or unknown name', () => {
    for (const name of ['browser_tab', 'browser_navigate', 'browser_list_tabs', 'terminal_send', 'nope']) expect(resolveToolAlias(name, {})).toBeUndefined();
  });

  it('puts the note first in the result', () => {
    expect(withAliasNote({ content: [{ type: 'text', text: 'Closed tab-2.' }] }, '(note)')).toEqual({ content: [{ type: 'text', text: '(note)\nClosed tab-2.' }] });
    expect(withAliasNote({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], isError: false }, '(note)').content[0]).toEqual({ type: 'text', text: '(note)' });
  });
});

describe('merged tool arguments', () => {
  it('browser_tab: select needs a tab, all goes with release only and not with tab', () => {
    expect(tabActionProblem({ action: 'select' })).toMatch(/needs `tab`.*Nothing was done\./);
    expect(tabActionProblem({ action: 'close', all: true })).toMatch(/^`all` goes only with \{"action":"release"\}/);
    expect(tabActionProblem({ action: 'release', all: true, tab: 'tab-1' })).toMatch(/`tab` or `all`, not both/);
    for (const ok of [{ action: 'select', tab: 'tab-1' }, { action: 'show' }, { action: 'release' }, { action: 'release', all: true }, { action: 'close', tab: 'tab-2' }] as const) expect(tabActionProblem(ok)).toBeUndefined();
  });

  it('browser_navigate: exactly one of url and action, ignoreCache with reload only', () => {
    expect(navigateProblem({})).toBe('browser_navigate needs `url` (the page to load) or `action` ("back", "forward" or "reload"). Nothing was done.');
    expect(navigateProblem({ url: 'localhost:3000', action: 'back' })).toMatch(/takes `url` or `action`, not both: pass \{"url":"localhost:3000"\} to load that page, or \{"action":"back"\} to go back\./);
    expect(navigateProblem({ url: 'x', ignoreCache: true })).toMatch(/^`ignoreCache` goes only with/);
    expect(navigateProblem({ action: 'back', ignoreCache: false })).toMatch(/^`ignoreCache` goes only with/);
    for (const ok of [{ url: 'x' }, { action: 'back' }, { action: 'reload', ignoreCache: true }] as const) expect(navigateProblem(ok)).toBeUndefined();
  });
});
