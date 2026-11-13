// browser_snapshot and browser_screenshot: reading what is on the page.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, image, text, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { elementArgs, tabArg } from './schema';
import { fullPageHeight, screenshotScale } from './screenshotMath';
import { TOGGLE_BRIDGE_UI } from './scripts';
import { renderSnapshot, type AXNode } from './snapshot';
import { elementBox, resolveTarget, scrollIntoView, viewport, type ElementTarget } from './targets';

const DEFAULT_SNAPSHOT_CHARS = 20_000;
const MAX_SNAPSHOT_CHARS = 60_000;
const MAX_FRAMES = 25;

interface DomFacts {
  pointer: Set<number>;
  hidden: Set<number>;
  frameOwners: Map<number, string>;
}

/** Reads cursor styles, the bridge's own UI elements and iframe → frame ids from one DOM snapshot. */
async function domFacts(call: PageCall): Promise<DomFacts | undefined> {
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

export async function snapshotText(call: PageCall, root: ElementTarget | undefined, maxChars: number): Promise<string> {
  const { state } = call;
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
  const pending = [...new Set(facts.frameOwners.values())].filter(id => id !== mainFrameId).slice(0, MAX_FRAMES);
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

  const loaderId = state.loaderId;
  const output = renderSnapshot({
    frames,
    mainFrameId,
    frameOwners: facts.frameOwners,
    pointer: facts.pointer,
    hidden: facts.hidden,
    root: root?.backendNodeId,
    maxChars,
    pageUrl: state.url,
    refFor: node => call.refs.assign(node, loaderId),
  });
  const title = String(main.nodes.find(n => n.role?.value === 'RootWebArea')?.name?.value ?? '');
  const scope = root ? `- Part of the page: ${root.label}\n` : '';
  const body = output.text || (root ? '(this element has no accessible content)' : '(the page is empty)');
  if (root && !output.rootFound) {
    return `- Page URL: ${state.url}\n- Page Title: ${title}\n${scope}(${root.label} is not part of the accessibility tree: it is hidden or presentational. Pick a visible container instead.)`;
  }
  return `- Page URL: ${clip(state.url, 500)}\n- Page Title: ${clip(title, 200)}\n${scope}- Snapshot of ${call.tab.id}:\n\`\`\`yaml\n${body}\n\`\`\``;
}

export function snapshotTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_snapshot',
      title: 'Read page (accessibility snapshot)',
      description:
        'Returns a text snapshot of the page from its accessibility tree: roles, names, values and states, one element per line, each with a ref (e.g. [ref=e12]) that browser_click, browser_type and the other action tools accept. Better than a screenshot for finding and acting on elements. Includes same-origin iframes and shadow DOM. Large pages are cut at maxChars with a list of the parts left out; pass ref or selector to read just one part.',
      input: {
        ...elementArgs,
        maxChars: z.number().int().min(2000).max(MAX_SNAPSHOT_CHARS).optional().describe(`Size budget in characters. Default ${DEFAULT_SNAPSHOT_CHARS}.`),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read' }, async call => {
          const root = (await resolveTarget(call, args, { waitMs: 0 })) as ElementTarget | undefined;
          return snapshotText(call, root, args.maxChars ?? DEFAULT_SNAPSHOT_CHARS);
        }),
    }),
    defineTool({
      name: 'browser_screenshot',
      title: 'Screenshot page',
      description:
        "Takes a screenshot of the visible part of the page (default), the full page, or one element, and returns it as an image sized for reading (at most ~1568 px on the long edge). Use it to check layout and visual state; use browser_snapshot to find elements to act on. The bridge's own session indicator is hidden in the image.",
      input: {
        ...elementArgs,
        fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Very tall pages are cut at the bottom to stay readable.'),
        format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg (smaller). png for pixel-exact text and colors.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read' }, async call => {
          const target = (await resolveTarget(call, args, { waitMs: 2000 })) as ElementTarget | undefined;
          if (target && args.fullPage) throw new ToolError('invalid_input', 'Pass either an element (ref/selector) or fullPage, not both.');
          if (target) await scrollIntoView(call, target);
          const vp = await viewport(call);
          let region: { x: number; y: number; width: number; height: number };
          let what: string;
          let cut = '';
          if (target) {
            const box = await elementBox(call, target.backendNodeId);
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
          const format = args.format ?? 'jpeg';
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
              ? scale === 1 ? ' Image pixels are viewport CSS pixels, so a point in it can be passed as x/y to browser_click.' : ` To click a point in it, divide its image coordinates by ${scale.toFixed(3)} and pass them as x/y to browser_click.`
              : '';
          return [image(data, `image/${format}`), text(`Screenshot of ${what} in ${call.tab.id} (${w}×${h} px; viewport ${Math.round(vp.width)}×${Math.round(vp.height)} CSS px).${mapping}${cut}`)];
        }),
    }),
  ];
}
