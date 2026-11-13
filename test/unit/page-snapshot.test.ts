import { describe, expect, it } from 'vitest';
import { RefTable } from '../../src/extension/browser/page/refs';
import { renderSnapshot, shortUrl, type AXNode, type SnapshotInput } from '../../src/extension/browser/page/snapshot';

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
        '- link "Docs" [ref=e5]:',
        '  - /url: /docs',
      ].join('\n'),
    );
  });

  it('hoists ignored and unnamed generic containers and merges text', () => {
    const tree = ax('RootWebArea', '', {
      children: [ax('generic', '', { children: [ax('none', '', { ignored: true, children: [text('Hello'), text('world')] }), ax('paragraph', '', { children: [text('Para')] })] })],
    });
    expect(render(tree).text).toBe(['- text: Hello world', '- paragraph [ref=e1]: Para'].join('\n'));
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
    expect(out.text).toMatch(/\[Snapshot cut: showing the first \d+ of \d+ characters/);
    const summary = out.text.slice(out.text.indexOf('Parts below the cut'));
    // Top-level sections come first, so the agent sees the page's structure; lists are not listed.
    expect(summary).toMatch(/^ {2}- region "Section 3" \[ref=e\d+\]$/m);
    expect(summary).toMatch(/… and \d+ more/);
    expect(summary).not.toMatch(/- list/);
    expect(summary).not.toMatch(/heading "Heading 3"/);
    expect(out.text).toMatch(/call browser_snapshot with ref set to one of these refs/);
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
