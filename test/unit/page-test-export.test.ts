import { describe, expect, it } from 'vitest';
import { AxIndex, chooseLocator, pickName, scopedLocator, playwrightRole, quote, renderLocator, roleUsable, selectorChain, textMatches } from '../../src/extension/browser/page/locatorLogic';
import { generateTest, playwrightKey, secretEnvName, urlPatternCode, type Step, type StepTarget } from '../../src/extension/browser/page/testCode';

const role = (r: string, name: string): StepTarget => ({ locator: { frames: [], parts: [{ kind: 'role', role: r, name }] }, robust: true, label: `${r} "${name}"` });

describe('text matching (Playwright rules)', () => {
  it('is a case-insensitive substring unless exact, with whitespace collapsed', () => {
    expect(textMatches('Create  account', 'create account', false)).toBe(true);
    expect(textMatches('Create account now', 'account', false)).toBe(true);
    expect(textMatches('Create account', 'create account', true)).toBe(false);
    expect(textMatches(' Create\naccount ', 'Create account', true)).toBe(true);
  });
});

describe('pickName', () => {
  it('uses the name as a substring when that is unique', () => {
    expect(pickName(['Save', 'Cancel'], 0)).toMatchObject({ name: 'Save', unique: true });
  });

  it('falls back to exact when the name is part of another one', () => {
    const r = pickName(['Save', 'Save draft'], 0);
    expect(r).toMatchObject({ name: 'Save', exact: true, unique: true });
  });

  it('gives the index among the matches when nothing is unique', () => {
    const r = pickName(['Delete', 'Delete', 'Delete'], 2);
    expect(r).toMatchObject({ name: 'Delete', unique: false, nth: 2, count: 3 });
  });

  it('shortens long names to a unique prefix', () => {
    const long = 'Item 25.3 with some descriptive text that goes on and on for quite a while longer than eighty characters';
    const r = pickName([long, 'Item 25.4 with some descriptive text'], 0);
    expect(r.unique).toBe(true);
    expect(r.name.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(r.name)).toBe(true);
  });

  it('picks the shortest leading words for containers', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `Widget ${i + 1} W-${String(i + 1).padStart(4, '0')} Lisbon Order`);
    expect(pickName(rows, 36, { shortest: true })).toMatchObject({ name: 'Widget 37', unique: true });
    // "Widget 3" would also match Widget 30-39: never chosen.
    expect(pickName(rows, 2, { shortest: true }).name).toBe('Widget 3 W-0003');
  });
});

describe('chooseLocator', () => {
  it('prefers a test id, then role and name', () => {
    expect(chooseLocator({ testId: { value: 'save', count: 1 }, role: { role: 'button', name: 'Save', unique: true, nth: 0, count: 1, ordered: true } }).parts).toEqual([{ kind: 'testid', value: 'save' }]);
    expect(chooseLocator({ testId: { value: 'save', count: 2 }, role: { role: 'button', name: 'Save', unique: true, nth: 0, count: 1, ordered: true } }).parts).toEqual([{ kind: 'role', role: 'button', name: 'Save' }]);
  });

  it('uses label, placeholder, text in that order when the role does not identify it', () => {
    const notUnique = { role: 'textbox', name: 'Email', unique: false, nth: 1, count: 2, ordered: true };
    expect(chooseLocator({ role: notUnique, label: { value: 'Email', count: 2, exactCount: 1 } }).parts).toEqual([{ kind: 'label', value: 'Email', exact: true }]);
    expect(chooseLocator({ role: notUnique, placeholder: { value: 'you@example.com', count: 1, exactCount: 1 } }).parts).toEqual([{ kind: 'placeholder', value: 'you@example.com' }]);
    expect(chooseLocator({ text: { value: 'Card A', count: 1, exactCount: 1, nth: 0 } }).parts).toEqual([{ kind: 'text', value: 'Card A' }]);
  });

  it('scopes to a unique container before using an index', () => {
    const scoped = { container: { kind: 'role' as const, role: 'row', name: 'Widget 37' }, inner: { kind: 'role' as const, role: 'button', name: 'Order' } };
    const r = chooseLocator({ role: { role: 'button', name: 'Order', unique: false, nth: 36, count: 60, ordered: true }, scoped });
    expect(r).toEqual({ parts: [scoped.container, scoped.inner], robust: true });
    const indexed = chooseLocator({ role: { role: 'button', name: 'Order', unique: false, nth: 36, count: 60, ordered: true } });
    expect(indexed).toEqual({ parts: [{ kind: 'role', role: 'button', name: 'Order', nth: 36 }], robust: false });
  });

  it('falls back to a stable CSS id, then a CSS path', () => {
    expect(chooseLocator({ cssId: '#total' }).parts).toEqual([{ kind: 'css', selector: '#total' }]);
    expect(chooseLocator({ css: { selector: 'main > div:nth-of-type(2) > span', count: 1, nth: 0 } })).toEqual({ parts: [{ kind: 'css', selector: 'main > div:nth-of-type(2) > span' }], robust: true });
    expect(chooseLocator({ css: { selector: 'li > span', count: 3, nth: 1 } })).toEqual({ parts: [{ kind: 'css', selector: 'li > span', nth: 1 }], robust: false });
  });

  it('uses getByRole only for roles Chrome and Playwright compute alike, and nameless only where that is useful', () => {
    expect(playwrightRole('button')).toBe('button');
    expect(playwrightRole('generic')).toBeUndefined();
    expect(playwrightRole('StaticText')).toBeUndefined();
    expect(roleUsable('checkbox', '')).toBe(true);
    expect(roleUsable('img', '')).toBe(false);
  });
});

describe('renderLocator', () => {
  it('prints Playwright code with frames, options and indexes', () => {
    expect(renderLocator({ frames: ['#login', 'iframe[title="Inner"]'], parts: [{ kind: 'role', role: 'button', name: "Don't", exact: true }] })).toBe(
      `page.frameLocator('#login').frameLocator('iframe[title="Inner"]').getByRole('button', { name: 'Don\\'t', exact: true })`,
    );
    expect(renderLocator({ frames: [], parts: [{ kind: 'text', value: 'Delete', nth: 0 }] })).toBe(`page.getByText('Delete').first()`);
    expect(renderLocator({ frames: [], parts: [{ kind: 'label', value: 'Email', exact: true, nth: 2 }] })).toBe(`page.getByLabel('Email', { exact: true }).nth(2)`);
    expect(renderLocator({ frames: [], parts: [{ kind: 'testid', value: 'x' }] })).toBe(`page.getByTestId('x')`);
  });

  it('quotes like Playwright', () => {
    expect(quote('a\'b\\c\nd')).toBe(`'a\\'b\\\\c\\nd'`);
  });

  it('turns copane frame selectors into frameLocator chains', () => {
    expect(selectorChain('#outer >>> #inner >>> button.save')).toEqual({ frames: ['#outer', '#inner'], parts: [{ kind: 'css', selector: 'button.save' }] });
  });
});

describe('generateTest', () => {
  const gen = (steps: Step[], startUrl = 'http://localhost:3000/login') => generateTest({ name: 'flow', startUrl, steps });

  it('starts at the page the recording started on, and imports expect only when used', () => {
    const t = gen([{ kind: 'click', target: role('button', 'Go') }]);
    expect(t.code).toContain(`import { test } from '@playwright/test';`);
    expect(t.code).toContain(`  await page.goto('http://localhost:3000/login');\n  await page.getByRole('button', { name: 'Go' }).click();`);
    const nav = gen([{ kind: 'goto', url: 'http://localhost:3000/' }, { kind: 'expectText', text: 'Hi' }]);
    expect(nav.code.match(/page\.goto/g)).toHaveLength(1);
    expect(nav.code).toContain(`import { test, expect } from '@playwright/test';`);
  });

  it('writes secrets as environment variables and says which', () => {
    const t = gen([{ kind: 'fill', target: role('textbox', 'Password'), value: { env: 'PASSWORD' } }]);
    expect(t.code).toContain(`.fill(process.env.PASSWORD!);`);
    expect(t.env).toEqual(['PASSWORD']);
    expect(t.code).toContain('// Needs PASSWORD in the environment');
  });

  it('prints every kind of step', () => {
    const t = gen([
      { kind: 'type', target: role('searchbox', 'Search'), value: 'vs code', submit: true },
      { kind: 'type', target: role('textbox', 'Tags'), value: ', more', append: true },
      { kind: 'type', value: 'typed' },
      { kind: 'check', target: role('checkbox', 'Terms'), checked: false },
      { kind: 'select', target: role('combobox', 'Country'), values: ['France'] },
      { kind: 'press', key: 'ctrl+Enter', count: 1 },
      { kind: 'press', target: role('textbox', 'Name'), key: 'ArrowDown', count: 3 },
      { kind: 'hover', target: role('link', 'Menu') },
      { kind: 'scroll', dx: 0, dy: 600 },
      { kind: 'drag', from: role('listitem', 'A'), to: role('region', 'Done') },
      { kind: 'upload', target: role('button', 'Attach'), files: ['a.txt', 'b.txt'], chooser: false },
      { kind: 'expectUrl', url: 'http://localhost:3000/done' },
      { kind: 'expectUrlPattern', pattern: '**/done*' },
      { kind: 'expectText', text: 'Gone', gone: true },
      { kind: 'expectSelector', selector: '#a >>> .toast', state: 'visible' },
      { kind: 'expectSelector', selector: '.spinner', state: 'detached' },
      { kind: 'waitLoad', state: 'networkidle' },
      { kind: 'history', action: 'back' },
    ]);
    for (const line of [
      `await page.getByRole('searchbox', { name: 'Search' }).fill('vs code');`,
      `await page.getByRole('searchbox', { name: 'Search' }).press('Enter');`,
      `await page.getByRole('textbox', { name: 'Tags' }).press('End');`,
      `await page.getByRole('textbox', { name: 'Tags' }).pressSequentially(', more');`,
      `await page.keyboard.type('typed');`,
      `await page.getByRole('checkbox', { name: 'Terms' }).uncheck();`,
      `await page.getByRole('combobox', { name: 'Country' }).selectOption('France');`,
      `await page.keyboard.press('Control+Enter');`,
      `for (let i = 0; i < 3; i++) await page.getByRole('textbox', { name: 'Name' }).press('ArrowDown');`,
      `await page.getByRole('link', { name: 'Menu' }).hover();`,
      `await page.mouse.wheel(0, 600);`,
      `await page.getByRole('listitem', { name: 'A' }).dragTo(page.getByRole('region', { name: 'Done' }));`,
      `await page.getByRole('button', { name: 'Attach' }).setInputFiles(['a.txt', 'b.txt']);`,
      `await expect(page).toHaveURL('http://localhost:3000/done');`,
      `await expect(page).toHaveURL(/^.*\\/done.*$/);`,
      `await expect(page.getByText('Gone').filter({ visible: true })).toHaveCount(0);`,
      `await expect(page.frameLocator('#a').locator('.toast').first()).toBeVisible();`,
      `await expect(page.locator('.spinner')).toHaveCount(0);`,
      `await page.waitForLoadState('networkidle');`,
      `await page.goBack();`,
    ]) expect(t.code).toContain(line);
  });

  it('flags coordinates and order-dependent locators', () => {
    const t = gen([
      { kind: 'click', target: { point: { x: 10.4, y: 20.6 }, label: '(10, 21)' } },
      { kind: 'click', target: { locator: { frames: [], parts: [{ kind: 'role', role: 'button', name: 'Delete', nth: 2 }] }, robust: false, label: 'button "Delete"' } },
    ]);
    expect(t.code).toContain('await page.mouse.click(10, 21);');
    expect(t.warnings[0]).toMatch(/step 1 acted on coordinates/);
    expect(t.warnings[1]).toMatch(/step 2 \(button "Delete"\) uses a locator that depends on order/);
  });

  it('asserts URLs with long query strings by their path only', () => {
    const t = gen([{ kind: 'expectUrl', url: 'https://app.example.com/callback?code=abcdef0123456789abcdef0123456789&state=xyz' }]);
    expect(t.code).toContain(`await expect(page).toHaveURL(/https:\\/\\/app\\.example\\.com\\/callback/);`);
  });

  it('puts dialog handlers in as they come', () => {
    const t = gen([{ kind: 'dialog', accept: true, promptText: 'Ada' }, { kind: 'click', target: role('button', 'Ask') }]);
    expect(t.code).toContain(`page.once('dialog', dialog => dialog.accept('Ada'));\n  await page.getByRole('button', { name: 'Ask' }).click();`);
  });
});

describe('helpers', () => {
  it('names keys the way Playwright does', () => {
    expect(playwrightKey('ControlOrMeta+a')).toBe('ControlOrMeta+a');
    expect(playwrightKey('ctrl+shift+k')).toBe('Control+Shift+k');
    expect(playwrightKey('esc')).toBe('Escape');
    expect(playwrightKey(' ')).toBe('Space');
    expect(playwrightKey('Shift++')).toBe('Shift++');
  });

  it('turns wait_for URL patterns into toHaveURL arguments', () => {
    expect(urlPatternCode('/\\/items\\/\\d+/')).toBe('/\\/items\\/\\d+/');
    expect(urlPatternCode('/checkout')).toBe('/\\/checkout/');
    expect(urlPatternCode('*/done')).toBe('/^.*\\/done$/');
  });

  it('makes environment variable names from field labels', () => {
    const taken = new Set<string>();
    expect(secretEnvName('Password', taken)).toBe('PASSWORD');
    taken.add('PASSWORD');
    expect(secretEnvName('Password', taken)).toBe('PASSWORD_2');
    expect(secretEnvName('Confirm password', taken)).toBe('CONFIRM_PASSWORD');
    expect(secretEnvName('2FA code', taken)).toBe('_2FA_CODE');
    expect(secretEnvName('***', taken)).toBe('SECRET');
  });
});

describe('AxIndex and scopedLocator', () => {
  // A table of rows with an "Order" button each; Chrome gives the rows no name.
  const nodes: any[] = [{ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['table'] }, { nodeId: 'table', parentId: 'root', role: { value: 'table' }, name: { value: 'Products' }, childIds: [] as string[] }];
  for (let i = 1; i <= 12; i++) {
    const row = `row${i}`;
    nodes[1].childIds.push(row);
    nodes.push(
      { nodeId: row, parentId: 'table', role: { value: 'row' }, name: { value: '' }, childIds: [`c${i}`, `b${i}`] },
      { nodeId: `c${i}`, parentId: row, role: { value: 'cell' }, name: { value: '' }, childIds: [`t${i}`] },
      { nodeId: `t${i}`, parentId: `c${i}`, role: { value: 'StaticText' }, name: { value: `Widget ${i}` } },
      { nodeId: `b${i}`, parentId: row, role: { value: 'button' }, name: { value: 'Order' }, backendDOMNodeId: 100 + i, childIds: [] },
    );
  }
  nodes.push({ nodeId: 'hidden', parentId: 'root', role: { value: 'button' }, name: { value: 'Order' }, ignored: true, backendDOMNodeId: 999 });
  nodes[0].childIds.push('hidden');
  const tree = new AxIndex(nodes);

  it('lists the nodes getByRole would match, in document order, leaving out ignored ones', () => {
    expect(tree.withRole('button').map(n => n.backendDOMNodeId)).toEqual(Array.from({ length: 12 }, (_, i) => 101 + i));
    expect(tree.byBackendId(999)).toBeUndefined();
  });

  it('names rows by their content, as Playwright does', () => {
    expect(tree.nameOf(nodes.find(n => n.nodeId === 'row7'))).toBe('Widget 7');
  });

  it('scopes an element to the unique container around it', () => {
    const self = tree.byBackendId(110)!;
    expect(scopedLocator(tree, self, 'button')).toEqual({ container: { kind: 'role', role: 'row', name: 'Widget 10' }, inner: { kind: 'role', role: 'button', name: 'Order' } });
    // "Widget 1" is part of "Widget 10".."Widget 12": only the exact name identifies row 1.
    expect(scopedLocator(tree, tree.byBackendId(101)!, 'button')?.container).toEqual({ kind: 'role', role: 'row', name: 'Widget 1', exact: true });
  });
});
