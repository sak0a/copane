import { describe, expect, it } from 'vitest';
import { RefTable } from '../../src/extension/browser/page/refs';
import { buildTree, diffLines, findInTree, renderSnapshot, renderText, shortUrl, snapshotLines, textWindow, type AXNode, type SnapshotInput } from '../../src/extension/browser/page/snapshot';

let nextId = 1;
/** Builds an AX node tree from a compact description. */
function ax(role: string, name = '', opts: { children?: AXNode[][]; props?: Record<string, unknown>; ignored?: boolean; value?: string; backend?: number } = {}): AXNode[] {
  const nodeId = String(nextId++);
  const kids = opts.children ?? [];
  const node: AXNode = {
    nodeId,
    role: { value: role },
    name: { value: name },
    ignored: opts.ignored,
    value: opts.value !== undefined ? { value: opts.value } : undefined,
    properties: Object.entries(opts.props ?? {}).map(([k, v]) => ({ name: k, value: { value: v } })),
    childIds: kids.map(k => k[0]!.nodeId),
    backendDOMNodeId: opts.backend ?? 1000 + Number(nodeId),
  };
  for (const k of kids) k[0]!.parentId = nodeId;
  return [node, ...kids.flat()];
}
const text = (t: string) => ax('StaticText', t);

function render(nodes: AXNode[], extra: Partial<SnapshotInput> = {}) {
  const table = new RefTable();
  const out = renderSnapshot({
    mainFrameId: 'main',
    frameOwners: new Map(),
    pointer: new Set(),
    hidden: new Set(),
    maxChars: 50_000,
    refFor: n => table.assign(n, 'L1'),
    ...extra,
    frames: new Map([['main', nodes], ...(extra.frames ?? new Map())]),
  });
  return { ...out, table };
}

describe('renderSnapshot', () => {
  it('prints roles, names, states and refs in the Playwright format', () => {
    const tree = ax('RootWebArea', 'Page', {
      children: [
        ax('heading', 'Title', { props: { level: 1 }, children: [text('Title')] }),
        ax('button', 'Save', { props: { disabled: true }, children: [text('Save')] }),
        ax('checkbox', 'Agree', { props: { checked: 'true' } }),
        ax('textbox', 'Email', { value: 'a@b.c', props: { focused: true, required: true } }),
        ax('link', 'Docs', { props: { url: 'http://x.test/docs' }, children: [text('Docs')] }),
      ],
    });
    const { text: out } = render(tree, { pageUrl: 'http://x.test/' });
    expect(out).toBe(
      [
        '- heading "Title" [level=1] [ref=e1]',
        '- button "Save" [disabled] [ref=e2]',
        '- checkbox "Agree" [checked] [ref=e3]',
        '- textbox "Email" [active] [required] [ref=e4]: a@b.c',
        '- link "Docs" [ref=e5]',
      ].join('\n'),
    );
  });

  it('hoists ignored and unnamed generic containers and merges text', () => {
    const tree = ax('RootWebArea', '', {
      children: [ax('generic', '', { children: [ax('none', '', { ignored: true, children: [text('Hello'), text('world')] }), ax('paragraph', '', { children: [text('Para')] })] })],
    });
    expect(render(tree).text).toBe(['- text: Hello world', '- paragraph: Para'].join('\n'));
  });

  it('keeps clickable generic elements, marked with cursor=pointer', () => {
    const div = ax('generic', '', { backend: 77, children: [text('Clickable')] });
    const tree = ax('RootWebArea', '', { children: [div] });
    expect(render(tree, { pointer: new Set([77]) }).text).toBe('- generic [ref=e1] [cursor=pointer]: Clickable');
  });

  it('leaves out the bridge UI', () => {
    const tree = ax('RootWebArea', '', { children: [ax('button', 'Indicator', { backend: 5 }), ax('button', 'Real')] });
    expect(render(tree, { hidden: new Set([5]) }).text).toBe('- button "Real" [ref=e1]');
  });

  it('prints a name once even when the text inside is spaced differently', () => {
    const tree = ax('RootWebArea', '', { children: [ax('link', 'Issues (5k+)', { children: [text('Issues ('), text('5k+'), text(')')] })] });
    expect(render(tree).text).toBe('- link "Issues (5k+)" [ref=e1]');
  });

  it('drops label text that repeats the field name', () => {
    const tree = ax('RootWebArea', '', { children: [ax('LabelText', '', { children: [text('Name'), ax('textbox', 'Name')] })] });
    expect(render(tree).text).toBe('- textbox "Name" [ref=e1]');
  });

  it('shows the selected option of a select and its options', () => {
    const tree = ax('RootWebArea', '', {
      children: [
        ax('combobox', 'Country', {
          props: { expanded: false },
          children: [ax('MenuListPopup', '', { children: [ax('option', 'Germany', { props: { selected: false } }), ax('option', 'France', { props: { selected: true } })] })],
        }),
      ],
    });
    expect(render(tree).text).toBe(['- combobox "Country" [expanded=false] [ref=e1]: France', '  - option "Germany" [ref=e2]', '  - option "France" [selected] [ref=e3]'].join('\n'));
  });

  it('inlines same-process iframes and marks cross-origin ones', () => {
    const inner = ax('RootWebArea', 'Inner', { children: [ax('button', 'In frame')] });
    const tree = ax('RootWebArea', '', { children: [ax('Iframe', 'Same', { backend: 10 }), ax('Iframe', 'Other', { backend: 11 })] });
    const out = render(tree, { frames: new Map([['child', inner]]), frameOwners: new Map([[10, 'child']]) }).text;
    expect(out).toBe(['- iframe "Same" [ref=e1]:', '  - button "In frame" [ref=e2]', '- iframe "Other" [ref=e3]: [cross-origin frame: its content cannot be read; use browser_screenshot and click by x/y]'].join('\n'));
  });

  it('renders only the subtree of root, and reports a missing root', () => {
    const tree = ax('RootWebArea', '', { children: [ax('navigation', 'Top', { children: [ax('link', 'A')] }), ax('main', '', { backend: 50, children: [ax('button', 'Go')] })] });
    expect(render(tree, { root: 50 }).text).toBe(['- main [ref=e1]:', '  - button "Go" [ref=e2]'].join('\n'));
    expect(render(tree, { root: 9999 }).rootFound).toBe(false);
  });

  it('keeps refs stable for the same node across snapshots, and new after navigation', () => {
    const table = new RefTable();
    const node = { backendNodeId: 1, frameId: 'main', role: 'button', name: 'A' };
    expect(table.assign(node, 'L1')).toBe('e1');
    expect(table.assign({ ...node, backendNodeId: 2 }, 'L1')).toBe('e2');
    expect(table.assign({ ...node, name: 'B' }, 'L1')).toBe('e1');
    expect(table.get('e1')?.name).toBe('B');
    expect(table.assign(node, 'L2')).toBe('e3');
    expect(table.get('[ref=e2]')?.backendNodeId).toBe(2);
  });

  it('cuts at the budget and lists the landmarks and headings below the cut', () => {
    const sections = Array.from({ length: 30 }, (_, i) =>
      ax('region', `Section ${i}`, { children: [ax('heading', `Heading ${i}`, { props: { level: 2 } }), ax('list', '', { children: Array.from({ length: 20 }, (_, j) => ax('listitem', '', { children: [text(`Item ${i}.${j} with a fair amount of text`)] })) })] }),
    );
    const out = render(ax('RootWebArea', '', { children: sections }), { maxChars: 4000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThan(4200);
    expect(out.text).toMatch(/\[Snapshot cut: showing characters 0-\d+ of \d+/);
    const summary = out.text.slice(out.text.indexOf('Parts below the cut'));
    // Top-level sections come first, so the agent sees the page's structure; lists are not listed.
    expect(summary).toMatch(/^ {2}- region "Section 3" \[ref=e\d+\]$/m);
    expect(summary).toMatch(/… and \d+ more/);
    expect(summary).not.toMatch(/- list/);
    expect(summary).not.toMatch(/heading "Heading 3"/);
    expect(out.text).toMatch(/call browser_snapshot with its ref; to read on, with offset \d+/);
    // Reading on from the offset continues where the cut was, inside its section.
    const end = Number(/with offset (\d+)/.exec(out.text)![1]);
    const next = render(ax('RootWebArea', '', { children: sections }), { maxChars: 4000, offset: end } as Partial<SnapshotInput>);
    expect(next.text.split('\n')[0]).toMatch(/# continued$|^- region/);
    expect(next.text).not.toContain('Item 0.0 ');
  });

  it('caps long option lists and long names', () => {
    const options = Array.from({ length: 40 }, (_, i) => ax('option', `Opt ${i}`));
    const out = render(ax('RootWebArea', '', { children: [ax('listbox', 'Many', { children: options }), ax('button', 'x'.repeat(400))] })).text;
    expect(out).toMatch(/… 15 more options/);
    expect(out).toMatch(/button "x{149}…"/);
  });
});

describe('shortUrl', () => {
  it('shortens same-origin URLs only', () => {
    expect(shortUrl('http://a.test/x?y#z', 'http://a.test/page')).toBe('/x?y#z');
    expect(shortUrl('http://b.test/x', 'http://a.test/page')).toBe('http://b.test/x');
    expect(shortUrl('mailto:x@y', 'http://a.test/')).toBe('mailto:x@y');
  });
});

describe('snapshot format', () => {
  it('puts refs only on what an agent acts on or narrows to', () => {
    const tree = ax('RootWebArea', '', {
      children: [
        ax('main', '', {
          children: [
            ax('heading', 'Title', { props: { level: 2 }, children: [text('Title')] }),
            ax('paragraph', '', { children: [text('Plain text')] }),
            ax('list', '', { children: [ax('listitem', '', { children: [text('Item')] })] }),
            ax('img', 'Logo'),
            ax('img', ''),
            ax('generic', '', { backend: 90, children: [text('Clickable')] }),
            ax('textbox', 'Search', { props: { focusable: true } }),
          ],
        }),
      ],
    });
    expect(render(tree, { pointer: new Set([90]) }).text).toBe(
      [
        '- main [ref=e1]:',
        '  - heading "Title" [level=2] [ref=e2]',
        '  - paragraph: Plain text',
        '  - list:',
        '    - listitem: Item',
        '  - img "Logo"',
        '  - generic [ref=e3] [cursor=pointer]: Clickable',
        '  - textbox "Search" [ref=e4]',
      ].join('\n'),
    );
  });

  it('leaves link targets out unless asked, except for links whose text does not say where they go', () => {
    const tree = ax('RootWebArea', '', {
      children: [
        ax('link', 'Docs', { props: { url: 'http://x.test/docs' }, children: [text('Docs')] }),
        ax('link', '', { props: { url: 'http://x.test/vote?id=1' }, children: [ax('img', '')] }),
        ax('link', 'here', { props: { url: 'http://y.test/a' }, children: [text('here')] }),
      ],
    });
    const plain = render(tree, { pageUrl: 'http://x.test/' });
    expect(plain.text).toBe(['- link "Docs" [ref=e1]', '- link [ref=e2] [url=/vote?id=1]', '- link "here" [ref=e3] [url=http://y.test/a]'].join('\n'));
    expect(plain.urlsOmitted).toBe(true);
    const all = render(tree, { pageUrl: 'http://x.test/', urls: true } as Partial<SnapshotInput>);
    expect(all.text.split('\n')[0]).toBe('- link "Docs" [ref=e1] [url=/docs]');
    expect(all.urlsOmitted).toBe(false);
  });

  it('drops separators and collapses single-child wrappers', () => {
    const link = (n: string) => ax('link', n, { children: [text(n)] });
    const tree = ax('RootWebArea', '', {
      children: [
        ax('navigation', 'Top', { children: [link('new'), text('|'), link('past'), text(' | '), link('ask')] }),
        ax('list', '', { children: [ax('listitem', '', { children: [link('One')] }), ax('listitem', '', { children: [link('Two')] })] }),
      ],
    });
    expect(render(tree).text).toBe(
      ['- navigation "Top" [ref=e1]:', '  - link "new" [ref=e2]', '  - link "past" [ref=e3]', '  - link "ask" [ref=e4]', '- list:', '  - link "One" [ref=e5]', '  - link "Two" [ref=e6]'].join('\n'),
    );
  });

  it('prints table rows of plain cells on one line, and running text with its links on one line', () => {
    const cell = (...kids: AXNode[][]) => ax('cell', '', { children: kids });
    const tree = ax('RootWebArea', '', {
      children: [
        ax('table', 'Stock', {
          children: [
            ax('caption', '', { children: [text('Stock')] }),
            ax('row', 'Product Price', { children: [ax('columnheader', 'Product', { children: [text('Product')] }), ax('columnheader', 'Price', { children: [text('Price')] })] }),
            ax('row', 'Widget 3.25', { children: [cell(ax('link', 'Widget', { children: [text('Widget')] })), cell(text('3.25'))] }),
            ax('row', '', { children: [cell(), cell()] }),
          ],
        }),
        ax('paragraph', '', { children: [text('Made by'), ax('link', 'Ada', { children: [text('Ada')] }), text('in 1843.')] }),
      ],
    });
    expect(render(tree).text).toBe(
      ['- table "Stock" [ref=e1]:', '  - row: Product | Price', '  - row: link "Widget" [ref=e2] | 3.25', '- paragraph: Made by link "Ada" [ref=e3] in 1843.'].join('\n'),
    );
  });

  it('prints a group name once when its legend repeats it', () => {
    const tree = ax('RootWebArea', '', { children: [ax('group', 'Plan', { children: [text('Plan'), ax('radio', 'Free'), ax('radio', 'Pro')] })] });
    expect(render(tree).text).toBe(['- group "Plan" [ref=e1]:', '  - radio "Free" [ref=e2]', '  - radio "Pro" [ref=e3]'].join('\n'));
  });
});

describe('renderText', () => {
  it('returns the main content as light markdown without refs or controls', () => {
    const tree = ax('RootWebArea', '', {
      children: [
        ax('navigation', 'Site', { children: [ax('link', 'Home', { children: [text('Home')] })] }),
        ax('main', '', {
          children: [
            ax('heading', 'Article', { props: { level: 1 } }),
            ax('paragraph', '', { children: [text('Text with a'), ax('link', 'link', { children: [text('link')] }), ax('link', '[1]', { children: [text('[1]')] }), text('.')] }),
            ax('list', '', { children: [ax('listitem', '', { children: [text('First')] }), ax('listitem', '', { children: [text('Second')] })] }),
            ax('table', '', { children: [ax('row', '', { children: [ax('cell', 'a', { children: [text('a')] }), ax('cell', 'b', { children: [text('b')] }), ax('cell', '', { children: [ax('button', 'Edit')] })] })] }),
            ax('button', 'Share'),
          ],
        }),
      ],
    });
    const out = renderText(buildTree(treeInput(tree)));
    expect(out.scope).toBe('the main content');
    expect(out.text).toBe(['# Article', 'Text with a link.', '- First', '- Second', '| a | b |'].join('\n'));
  });

  it('cuts at a line boundary and continues from an offset', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i} of the text`).join('\n');
    const first = textWindow(text, 0, 200);
    expect(first.text.endsWith('text')).toBe(true);
    const next = textWindow(text, first.end, 200);
    expect(next.text.startsWith('Line ')).toBe(true);
    expect(first.text + '\n' + next.text).toBe(text.slice(0, next.end));
  });
});

describe('findInTree', () => {
  it('returns only matching elements, grouped by where they are', () => {
    const tree = ax('RootWebArea', '', {
      children: [
        ax('navigation', 'Top', { children: [ax('link', 'Stars', { children: [text('Stars')] })] }),
        ax('main', '', {
          children: [
            ax('heading', 'About', { props: { level: 2 } }),
            ax('paragraph', '', { children: [text('39.6k stars and counting')] }),
            ax('button', 'Fork'),
          ],
        }),
      ],
    });
    const table = new RefTable();
    const out = findInTree(buildTree(treeInput(tree)), 'stars', { refFor: n => table.assign(n, 'L1'), maxChars: 5000 });
    expect(out.matches).toBe(2);
    expect(out.text).toBe(['# in navigation "Top":', '- link "Stars" [ref=e1]', '# in main, under heading "About":', '- text: 39.6k stars and counting'].join('\n'));
  });
});

describe('diffLines', () => {
  const lines = (nodes: AXNode[]) => snapshotLines(buildTree(treeInput(nodes)), undefined);
  it('reports new and changed elements with the line they are under, and what is gone', () => {
    const before = ax('RootWebArea', '', {
      children: [
        ax('form', 'Sign up', { backend: 1, children: [ax('textbox', 'Name', { backend: 2 }), ax('button', 'Save', { backend: 3, props: { disabled: true } })] }),
        ax('dialog', 'Cookies', { backend: 4, children: [ax('button', 'OK', { backend: 5 })] }),
        ax('status', '', { backend: 6 }),
      ],
    });
    const after = ax('RootWebArea', '', {
      children: [
        ax('form', 'Sign up', { backend: 1, children: [ax('textbox', 'Name', { backend: 2, value: 'Ada', props: { focused: true } }), ax('button', 'Save', { backend: 3 })] }),
        ax('status', '', { backend: 6, children: [text('Saved')] }),
      ],
    });
    const diff = diffLines(lines(before), lines(after), new Set(['main:2']));
    const shown = diff.added.map(l => l.replace(/\u0001[^\u0001]+\u0001/g, 'eN'));
    expect(shown).toEqual(['- form "Sign up" [ref=eN]:', '  - button "Save" [ref=eN]', '- status: Saved']);
    expect(diff.removed).toEqual(['dialog "Cookies"', 'button "OK"']);
  });

  it('finds nothing when nothing changed but focus', () => {
    const page = (focused: boolean) => ax('RootWebArea', '', { children: [ax('button', 'Go', { backend: 3, props: { focused } })] });
    const diff = diffLines(lines(page(false)), lines(page(true)));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

function treeInput(nodes: AXNode[]) {
  return { frames: new Map([['main', nodes]]), mainFrameId: 'main', frameOwners: new Map<number, string>(), pointer: new Set<number>(), hidden: new Set<number>() };
}
