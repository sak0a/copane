// browser_snapshot and browser_screenshot: reading what is on the page.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, image, text, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { addCrossOriginFrames } from './frameSnapshot';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { elementArgs, tabArg } from './schema';
import { fullPageHeight, screenshotScale } from './screenshotMath';
import { TOGGLE_BRIDGE_UI } from './scripts';
import { buildTree, findInTree, renderText, renderTree, snapshotLines, textWindow, type AXNode, type RefNode, type Tree } from './snapshot';
import { elementBox, resolveTarget, scrollIntoView, viewport, type ElementTarget } from './targets';

const DEFAULT_SNAPSHOT_CHARS = 20_000;
const DEFAULT_FIND_CHARS = 6000;
const MAX_SNAPSHOT_CHARS = 60_000;
const MAX_FRAMES = 25;

export interface DomFacts {
  pointer: Set<number>;
  hidden: Set<number>;
  frameOwners: Map<number, string>;
}

/** Reads cursor styles, the bridge's own UI elements and iframe → frame ids from one DOM snapshot. */
export async function domFacts(call: PageCall): Promise<DomFacts | undefined> {
  let ds: any;
  try {
    ds = await call.send('DOMSnapshot.captureSnapshot', { computedStyles: ['cursor'], includeDOMRects: false });
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return undefined;
  }
  const strings: string[] = ds.strings;
  const facts: DomFacts = { pointer: new Set(), hidden: new Set(), frameOwners: new Map() };
  for (const doc of ds.documents as any[]) {
    const nodes = doc.nodes;
    const backend: number[] = nodes.backendNodeId ?? [];
    const parent: number[] = nodes.parentIndex ?? [];
    const attributes: number[][] | undefined = nodes.attributes;
    const cursor = new Map<number, string>();
    const layoutNodes: number[] = doc.layout?.nodeIndex ?? [];
    const styles: number[][] = doc.layout?.styles ?? [];
    layoutNodes.forEach((nodeIndex, i) => {
      const s = styles[i];
      if (s && s[0] !== undefined && s[0] >= 0) cursor.set(nodeIndex, strings[s[0]]!);
    });
    for (let i = 0; i < backend.length; i++) {
      const attrs = attributes?.[i];
      if (attrs) for (let k = 0; k < attrs.length; k += 2) if (strings[attrs[k]!] === 'data-copane-ui') facts.hidden.add(backend[i]!);
      if (cursor.get(i) === 'pointer' && cursor.get(parent[i]!) !== 'pointer') facts.pointer.add(backend[i]!);
    }
    const cdi = nodes.contentDocumentIndex;
    if (cdi) {
      (cdi.index as number[]).forEach((nodeIndex, k) => {
        const child = ds.documents[cdi.value[k]];
        if (child) facts.frameOwners.set(backend[nodeIndex]!, strings[child.frameId]!);
      });
    }
  }
  return facts;
}

export interface PageCapture {
  tree: Tree;
  title: string;
  url: string;
  loaderId: string | undefined;
  /** The ref-table node for a node of the tree: its real element and, for a cross-origin frame, the frame it lives in. */
  refNode(node: RefNode): RefNode;
}

/** Reads the page's accessibility tree (main frame and same-process frames) into a Tree. */
export async function capturePage(call: PageCall, root?: ElementTarget): Promise<PageCapture> {
  const { state } = call;
  const loaderId = state.loaderId;
  const facts = (await domFacts(call)) ?? { pointer: new Set<number>(), hidden: new Set<number>(), frameOwners: new Map<number, string>() };
  const mainFrameId = state.mainFrameId ?? (await call.send('Page.getFrameTree')).frameTree.frame.id;
  const frames = new Map<string, AXNode[]>();
  const main = await call.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId: mainFrameId });
  frames.set(mainFrameId, main.nodes);

  // Child frames: those in the DOM snapshot are in this process and readable; the rest are cross-origin.
  if (facts.frameOwners.size === 0) {
    for (const n of main.nodes) {
      if (n.role?.value !== 'Iframe' || n.backendDOMNodeId === undefined) continue;
      try {
        const { node } = await call.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId });
        if (node.frameId) facts.frameOwners.set(n.backendDOMNodeId, node.frameId);
      } catch (err) {
        if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
      }
    }
  }
  const pending = [...new Set(facts.frameOwners.values())].filter(id => id !== mainFrameId && !state.frames.get(id)).slice(0, MAX_FRAMES);
  await Promise.all(
    pending.map(async frameId => {
      try {
        const { nodes } = await call.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId });
        frames.set(frameId, nodes);
      } catch (err) {
        if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
      }
    }),
  );

  // Cross-origin frames (frameSnapshot.ts): their trees join the input with node ids made unique.
  const remote = await addCrossOriginFrames(call, { frames, facts, root, collectFacts: domFacts, viewport: await viewport(call) });
  const tree = buildTree({
    frames,
    mainFrameId,
    frameOwners: facts.frameOwners,
    pointer: facts.pointer,
    hidden: facts.hidden,
    root: root ? remote.idOf(root) : undefined,
    pageUrl: state.url,
    frameNote: frameId => remote.note(frameId),
  });
  const title = String(main.nodes.find(n => n.role?.value === 'RootWebArea')?.name?.value ?? '');
  return { tree, title, url: state.url, loaderId, refNode: node => remote.refNode(node) };
}

/** Remembers a whole-page capture as what this session last saw of the page (see changes.ts). */
export function rememberPage(call: PageCall, capture: PageCapture): { loaderId: string | undefined; lines: string[] } {
  const seen = { loaderId: capture.loaderId, lines: snapshotLines(capture.tree, capture.url) };
  call.env.baselines.set(call.sessionTabKey, seen);
  return seen;
}

interface ReadArgs {
  mode?: 'snapshot' | 'text';
  find?: string;
  urls?: boolean;
  offset?: number;
  maxChars?: number;
}

/** browser_snapshot's result for a capture. */
export function readResult(call: PageCall, capture: PageCapture, root: ElementTarget | undefined, args: ReadArgs): string {
  const { tree, title, url } = capture;
  const head = `- Page URL: ${clip(url, 500)}\n- Page Title: ${clip(title, 200)}\n`;
  if (root && !tree.rootFound) {
    return `${head}(${root.label} is not part of the accessibility tree: it is hidden or presentational. Pick a visible container instead.)`;
  }
  const scope = root ? `- Part of the page: ${root.label}\n` : '';
  const maxChars = args.maxChars ?? (args.find !== undefined ? DEFAULT_FIND_CHARS : DEFAULT_SNAPSHOT_CHARS);
  const refFor = (node: RefNode) => call.refs.assign(capture.refNode(node), capture.loaderId);
  const options = { refFor, maxChars, urls: args.urls, pageUrl: url, offset: args.offset };

  if (args.find !== undefined) {
    const found = findInTree(tree, args.find, options);
    if (found.matches === 0) return `${head}${scope}Nothing in ${call.tab.id} matches "${clip(args.find, 100)}" (names, values and text${args.urls ? ' and link targets' : ''} of ${root ? 'that part' : 'the whole page'} were searched, case-insensitive).`;
    const more = found.matches > found.shown ? `\n[${found.matches - found.shown} more matches not shown: make find more specific, or raise maxChars.]` : '';
    return `${head}${scope}- ${found.matches} match${found.matches === 1 ? '' : 'es'} for "${clip(args.find, 100)}" in ${call.tab.id}:\n\`\`\`yaml\n${found.text}\n\`\`\`${more}`;
  }

  if (args.mode === 'text') {
    const rendered = renderText(tree);
    const what = root ? 'that part' : rendered.scope;
    if (!rendered.text) return `${head}${scope}${what === 'the whole page' ? 'The page shows no text.' : `There is no text in ${what}.`} Use browser_snapshot without mode to see its elements.`;
    const win = textWindow(rendered.text, args.offset ?? 0, maxChars);
    const left = root || rendered.scope === 'the whole page' ? 'controls left out' : 'menus, sidebars and controls left out';
    const cut = win.end < win.total ? `\n[Cut at character ${win.end} of ${win.total}: call again with offset ${win.end} to read on.]` : '';
    return `${head}${scope}- Text of ${what} in ${call.tab.id} (${left}; browser_snapshot without mode gives refs to act on):\n${win.text}${cut}`;
  }

  const output = renderTree(tree, options);
  const body = output.text || (root ? '(this element has no accessible content)' : '(the page is empty)');
  const urlsNote = output.urlsOmitted ? '\n[Link targets are left out; pass urls: true to see them.]' : '';
  return `${head}${scope}- Snapshot of ${call.tab.id}:\n\`\`\`yaml\n${body}\n\`\`\`${urlsNote}`;
}

export function snapshotTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_snapshot',
      title: 'Read page',
      description:
        'Reads the page: an accessibility snapshot with a ref (e.g. [ref=e12]) on each element you can act on, for the action tools. mode "text" returns just the readable text, find just the matching elements. Covers shadow DOM and iframes, cross-origin ones too.',
      input: {
        mode: z.enum(['snapshot', 'text']).optional().describe('text: main content as markdown, no refs; cheapest for reading.'),
        find: z.string().min(1).optional().describe('Only elements whose text contains this, with where they are.'),
        ...elementArgs,
        urls: z.boolean().optional().describe('Show all link targets.'),
        offset: z.number().int().min(0).optional().describe('Continue a cut result from this character.'),
        maxChars: z.number().int().min(2000).max(MAX_SNAPSHOT_CHARS).optional().describe(`Default ${DEFAULT_SNAPSHOT_CHARS}.`),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read' }, async call => {
          if (args.find !== undefined && args.mode === 'text') throw new ToolError('invalid_input', 'Pass either find or mode "text", not both.');
          if (args.find !== undefined && !args.find.trim()) throw new ToolError('invalid_input', 'find needs some text to look for.');
          const root = (await resolveTarget(call, args, { waitMs: 0 })) as ElementTarget | undefined;
          const capture = await capturePage(call, root);
          if (!root) rememberPage(call, capture);
          return readResult(call, capture, root, args);
        }),
    }),
    defineTool({
      name: 'browser_screenshot',
      title: 'Screenshot page',
      description: 'Takes a screenshot of the viewport, the full page or one element, to check layout and visual state.',
      input: {
        ...elementArgs,
        fullPage: z.boolean().optional(),
        format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg; png for exact pixels.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read' }, async call => {
          const target = (await resolveTarget(call, args, { waitMs: 2000 })) as ElementTarget | undefined;
          if (target && args.fullPage) throw new ToolError('invalid_input', 'Pass either an element (ref/selector) or fullPage, not both.');
          if (target) await scrollIntoView(call, target);
          const format = args.format ?? 'jpeg';
          for (const hook of env.hooks ?? []) {
            const shot = await hook.screenshot?.(call, { target, fullPage: Boolean(args.fullPage), format });
            if (shot) return shot;
          }
          const vp = await viewport(call);
          let region: { x: number; y: number; width: number; height: number };
          let what: string;
          let cut = '';
          if (target) {
            const box = await elementBox(target.call, target.backendNodeId);
            if (!box || box.width < 1 || box.height < 1) throw new ToolError('failed', `${target.label} has no visible box to capture (it is hidden or empty).`);
            region = { x: box.x + vp.pageX, y: box.y + vp.pageY, width: box.width, height: box.height };
            what = target.label;
          } else if (args.fullPage) {
            const height = fullPageHeight(vp.contentWidth, vp.contentHeight);
            region = { x: 0, y: 0, width: vp.contentWidth, height };
            what = 'the full page';
            if (height < vp.contentHeight) cut = ` The page is ${Math.round(vp.contentHeight)} px tall; only the top ${height} px were captured to keep the image readable. Scroll with browser_scroll and take viewport screenshots for the rest.`;
          } else {
            region = { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height };
            what = 'the viewport';
          }
          const scale = screenshotScale(region.width, region.height);
          let hidden = 0;
          try {
            hidden = await call.evaluate<number>(TOGGLE_BRIDGE_UI, [true]);
          } catch (err) {
            if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
          }
          let data: string;
          try {
            ({ data } = await call.send('Page.captureScreenshot', {
              format,
              ...(format === 'jpeg' ? { quality: 80 } : {}),
              clip: { ...region, scale: scale / vp.dpr },
              captureBeyondViewport: Boolean(args.fullPage || region.y < vp.pageY || region.y + region.height > vp.pageY + vp.height),
              fromSurface: true,
            }));
          } finally {
            if (hidden > 0 && !call.state.dialog) await call.evaluate(TOGGLE_BRIDGE_UI, [false]).catch(() => undefined);
          }
          const w = Math.round(region.width * scale);
          const h = Math.round(region.height * scale);
          const mapping =
            !target && !args.fullPage
              ? scale === 1 ? ' Its pixels are CSS px: usable as x/y for browser_click.' : ` For browser_click x/y, divide its coordinates by ${scale.toFixed(3)}.`
              : '';
          return [image(data, `image/${format}`), text(`Screenshot of ${what} in ${call.tab.id}, ${w}×${h} px.${mapping}${cut}`)];
        }),
    }),
  ];
}
