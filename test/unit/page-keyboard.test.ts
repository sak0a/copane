import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MIN_CHANGED_PIXELS,
  OPAQUE_LIMIT,
  WalkTracker,
  changedPixels,
  decodePng,
  decideEnd,
  endNeeds,
  focusShows,
  judgeSkipLink,
  orderJumps,
  signatureOf,
  splitInside,
  type Observed,
  type OrderStop,
  type RawStyle,
  type SkipStop,
  type StepVerdict,
} from '../../src/extension/browser/page/keyboardLogic';
import { formatKeyboard, MAX_LISTED_STOPS, type KbInput } from '../../src/extension/browser/page/keyboardReport';

/** Feeds observations to a tracker (a plain string = a key); returns the first verdict that is not "continue" (or the last). */
function walk(steps: Array<string | undefined | Observed>): { verdict: StepVerdict; tracker: WalkTracker } {
  const tracker = new WalkTracker();
  let verdict: StepVerdict = { kind: 'continue' };
  for (const s of steps) {
    verdict = tracker.push(typeof s === 'object' ? s : { key: s });
    if (verdict.kind !== 'continue') break;
  }
  return { verdict, tracker };
}
const captured = (key: string): Observed => ({ key, captured: true });
const opaque = (key: string): Observed => ({ key, opaque: true });

describe('WalkTracker', () => {
  it('ends a full round when focus comes back to stop 1', () => {
    const { verdict, tracker } = walk(['a', 'b', 'c', 'a']);
    expect(verdict).toEqual({ kind: 'wrap' });
    expect(tracker.stops).toEqual(['a', 'b', 'c']);
  });

  it('ends when focus leaves the page', () => {
    expect(walk(['a', 'b', undefined]).verdict).toEqual({ kind: 'left' });
  });

  it('calls Tab captured only when the page took the key (preventDefault); a press that did not move focus otherwise is ignored', () => {
    expect(walk(['a', 'b', 'b', 'c', 'a']).verdict).toEqual({ kind: 'wrap' });
    expect(walk(['a', 'b', 'b', 'b', 'b', 'c', 'a']).verdict).toEqual({ kind: 'wrap' });
    const { verdict, tracker } = walk(['a', 'b', captured('b')]);
    expect(verdict).toEqual({ kind: 'stuck', index: 1 });
    expect(tracker.stops).toEqual(['a', 'b']);
  });

  it('a captured Tab on the only stop is stuck, not a wrap (an editor that takes Tab)', () => {
    expect(walk(['ed', captured('ed')]).verdict).toEqual({ kind: 'stuck', index: 0 });
    expect(walk(['ed', 'ed', 'ed']).verdict).toEqual({ kind: 'continue' });
  });

  it('focus staying on an opaque container counts as stops inside it, and wraps and cycles as usual', () => {
    const { verdict, tracker } = walk(['a', 'x', opaque('x'), opaque('x'), 'b', 'a']);
    expect(verdict).toEqual({ kind: 'wrap' });
    expect(tracker.stops).toEqual(['a', 'x', 'x~1', 'x~2', 'b']);
    expect(splitInside('x~2')).toEqual({ key: 'x', inside: 2 });
    expect(splitInside('top#12')).toEqual({ key: 'top#12', inside: 0 });
    // An opaque container as stop 1 with stops inside it: the wrap is the next time focus reaches it from outside.
    expect(walk(['F', opaque('F'), opaque('F'), 'b', 'F']).tracker.stops).toEqual(['F', 'F~1', 'F~2', 'b']);
    // A cycle that goes through a container repeats its inside stops too.
    expect(walk(['s', 'x', opaque('x'), 'y', 'x', opaque('x'), 'y', 'x']).verdict).toEqual({ kind: 'cycle', start: 1, length: 3 });
  });

  it('gives up on an element after OPAQUE_LIMIT presses that do not leave it', () => {
    const inside = Array.from({ length: OPAQUE_LIMIT }, () => opaque('x'));
    expect(walk(['a', 'x', ...inside]).verdict).toEqual({ kind: 'opaque', index: OPAQUE_LIMIT - 1 + 1 });
    const still = Array.from({ length: OPAQUE_LIMIT }, () => 'x');
    expect(walk(['a', 'x', ...still]).verdict).toEqual({ kind: 'opaque', index: 1 });
  });

  it('finds a cycle when the same stops follow again in the same order, and lists one round', () => {
    const { verdict, tracker } = walk(['x', 'm', 's', 'c', 'm', 's', 'c', 'm']);
    expect(verdict).toEqual({ kind: 'cycle', start: 1, length: 3 });
    expect(tracker.stops).toEqual(['x', 'm', 's', 'c']);
  });

  it('keeps going when focus returns once but the order does not repeat', () => {
    const { verdict, tracker } = walk(['a', 'b', 'c', 'b', 'd', 'e', 'a']);
    expect(verdict).toEqual({ kind: 'wrap' });
    expect(tracker.stops).toEqual(['a', 'b', 'c', 'b', 'd', 'e']);
  });

  it('a two-stop cycle', () => {
    expect(walk(['a', 'b', 'c', 'b', 'c', 'b']).verdict).toEqual({ kind: 'cycle', start: 1, length: 2 });
  });
});

describe('decideEnd', () => {
  const facts = (verdict: Parameters<typeof decideEnd>[0]['verdict'], inModal: boolean[], extra: Partial<Parameters<typeof decideEnd>[0]> = {}) =>
    decideEnd({ verdict, inModal, region: false, limitReached: false, ...extra });

  it('a wrap on the whole page is complete only when no reachable stop was missed', () => {
    expect(facts({ kind: 'wrap' }, [false, false, false])).toEqual({ kind: 'complete' });
    // A trap holding stop 1: Tab goes b1, b2, b3, b1 while another button is reachable.
    expect(facts({ kind: 'wrap' }, [false, false, false], { missedTabStop: true })).toEqual({ kind: 'cycle', start: 0, length: 3 });
    expect(endNeeds({ kind: 'wrap' }, [false, false], false)).toBe('missed-stop');
  });

  it('focus kept inside a modal dialog (native or aria-modal) is contained, whether it wraps or cycles', () => {
    expect(facts({ kind: 'wrap' }, [true, true, true])).toEqual({ kind: 'modal' });
    expect(facts({ kind: 'cycle', start: 2, length: 3 }, [false, false, true, true, true])).toEqual({ kind: 'modal' });
    expect(facts({ kind: 'cycle', start: 1, length: 2 }, [false, false, false])).toEqual({ kind: 'cycle', start: 1, length: 2 });
    expect(endNeeds({ kind: 'wrap' }, [true, true], false)).toBeUndefined();
  });

  it('a region that wraps is a trap unless it holds the page start', () => {
    expect(facts({ kind: 'wrap' }, [false, false], { region: true })).toEqual({ kind: 'cycle', start: 0, length: 2 });
    expect(facts({ kind: 'wrap' }, [false, false], { region: true, regionHoldsPageStart: true })).toEqual({ kind: 'complete' });
    expect(endNeeds({ kind: 'wrap' }, [false], true)).toBe('region-start');
    expect(facts({ kind: 'outside' }, [false], { region: true })).toEqual({ kind: 'left-region' });
    expect(facts({ kind: 'outside' }, [], { region: true })).toEqual({ kind: 'empty' });
  });

  it('no stops at all, limits, stuck and opaque', () => {
    expect(facts({ kind: 'left' }, [])).toEqual({ kind: 'none' });
    expect(facts({ kind: 'wrap' }, [])).toEqual({ kind: 'none' });
    expect(facts({ kind: 'continue' }, [false], { limitReached: true })).toEqual({ kind: 'limit' });
    expect(facts({ kind: 'continue' }, [false])).toEqual({ kind: 'time' });
    expect(facts({ kind: 'stuck', index: 0 }, [false])).toEqual({ kind: 'stuck', index: 0 });
    expect(facts({ kind: 'opaque', index: 1 }, [false, false])).toEqual({ kind: 'opaque', index: 1 });
    expect(endNeeds({ kind: 'left' }, [false], false)).toBeUndefined();
  });
});

const base: RawStyle = {
  outlineStyle: 'none',
  outlineWidth: '0px',
  outlineColor: 'rgb(0, 0, 0)',
  outlineOffset: '0px',
  boxShadow: 'none',
  borderWidths: ['1px', '1px', '1px', '1px'],
  borderStyles: ['solid', 'solid', 'solid', 'solid'],
  borderColors: ['rgb(136, 136, 136)', 'rgb(136, 136, 136)', 'rgb(136, 136, 136)', 'rgb(136, 136, 136)'],
  backgroundColor: 'rgb(238, 238, 238)',
  backgroundImage: 'none',
  color: 'rgb(0, 0, 0)',
  textDecoration: 'none rgb(0, 0, 0)',
  opacity: '1',
  transform: 'none',
  content: 'none',
};
const sig = (s: Partial<RawStyle>) => [{ ...base, ...s }, null, null, base, base];

describe('focus visibility', () => {
  it('outline: none with nothing else changing is invisible', () => {
    expect(focusShows(sig({ outlineStyle: 'none', outlineWidth: '3px', outlineColor: 'red' }), sig({}))).toBe(false);
  });

  it('a box-shadow ring is visible', () => {
    expect(focusShows(sig({ boxShadow: 'rgb(0, 0, 255) 0px 0px 0px 3px' }), sig({}))).toBe(true);
  });

  it('a border colour change on a zero-width border is invisible; on a real border it is visible', () => {
    const zero = { borderWidths: ['0px', '0px', '0px', '0px'] };
    expect(focusShows(sig({ ...zero, borderColors: ['red', 'red', 'red', 'red'] }), sig(zero))).toBe(false);
    expect(focusShows(sig({ borderColors: ['red', 'red', 'red', 'red'] }), sig({}))).toBe(true);
  });

  it('the browser default ring (outline-style auto) is visible', () => {
    expect(focusShows(sig({ outlineStyle: 'auto', outlineWidth: '1px' }), sig({}))).toBe(true);
  });

  it(':focus-within on an ancestor and a ::after underline count', () => {
    const focused = [base, null, { ...base, content: '""', backgroundColor: 'red' }, base, base];
    expect(focusShows(focused, [base, null, null, base, base])).toBe(true);
    expect(focusShows([base, null, null, { ...base, backgroundColor: 'yellow' }, base], [base, null, null, base, base])).toBe(true);
  });

  it('signatureOf ignores the outline colour of an outline that is not drawn', () => {
    expect(signatureOf({ ...base, outlineColor: 'red' })).toBe(signatureOf(base));
    expect(signatureOf(null)).toBe('-');
  });
});

describe('orderJumps', () => {
  const s = (label: string, x: number, y: number, extra: Partial<OrderStop> = {}): OrderStop => ({ label, box: { x, y, width: 60, height: 20 }, doc: 'top', ...extra });

  it('counts every positive tabindex and up-jumps of more than 200 px', () => {
    const stops = [s('A', 0, 2200, { tabindex: 3 }), s('B', 0, 10), s('C', 100, 10), s('D', 0, 400), s('E', 0, 250)];
    const r = orderJumps(stops, true);
    expect(r.count).toBe(2);
    expect(r.shown.map(j => j.kind)).toEqual(['tabindex', 'up']);
    expect(r.shown[0]!.text).toBe('A (0,2200) comes first (tabindex=3)');
    expect(r.shown[1]!.text).toBe('A (0,2200) → B (0,10) (jumps 2190 px up)');
  });

  it('shows the step into a positive tabindex from the stop before', () => {
    expect(orderJumps([s('A', 0, 10), s('B', 0, 900, { tabindex: 2 })], true).shown[0]!.text).toBe('A (0,10) → B (0,900) (tabindex=2)');
  });

  it('does not judge fixed or sticky elements or steps between documents', () => {
    expect(orderJumps([s('A', 0, 2000), s('B', 0, 10, { fixed: true })], true).count).toBe(0);
    expect(orderJumps([s('A', 0, 2000, { fixed: true }), s('B', 0, 10)], true).count).toBe(0);
    expect(orderJumps([s('A', 0, 2000), s('B', 0, 10, { doc: 'frame' })], true).count).toBe(0);
  });

  it('a step back to the left in the same row counts on left-to-right pages only', () => {
    const stops = [s('A', 300, 10), s('B', 100, 12)];
    expect(orderJumps(stops, true).shown.map(j => j.kind)).toEqual(['back']);
    expect(orderJumps(stops, false).count).toBe(0);
  });

  it('shows at most five', () => {
    const stops = Array.from({ length: 8 }, (_, i) => s(`S${i}`, 0, 0, { tabindex: i + 1 }));
    const r = orderJumps(stops, true);
    expect(r.count).toBe(8);
    expect(r.shown).toHaveLength(5);
  });
});

describe('judgeSkipLink', () => {
  const link = (name: string, skip: SkipStop['skip'], inMain = false): SkipStop => ({ label: `link "${name}" [ref=e1]`, name, skip, inMain });
  const nav = (n: number) => Array.from({ length: n }, (_, i): SkipStop => ({ label: `link "N${i}"`, name: `N${i}`, inMain: false }));
  const main: SkipStop = { label: 'button "Buy" [ref=e9]', name: 'Buy', inMain: true };

  it('missing: no skip link and five or more stops before the main content', () => {
    expect(judgeSkipLink([...nav(6), main])).toEqual({ kind: 'missing', before: 6, firstMain: 'button "Buy" [ref=e9]' });
    expect(judgeSkipLink([...nav(3), main])).toEqual({ kind: 'not-needed' });
    expect(judgeSkipLink(nav(8))).toEqual({ kind: 'unknown' });
  });

  it('broken: the target does not exist, is hidden, or the href is just "#"', () => {
    expect(judgeSkipLink([link('Skip to content', { target: 'content', exists: false, rendered: false, main: false }), ...nav(6), main])).toMatchObject({ kind: 'broken', why: 'nothing on the page has id "content"' });
    expect(judgeSkipLink([link('Skip navigation', { target: 'main', exists: true, rendered: false, main: true }), ...nav(6), main])).toMatchObject({ kind: 'broken' });
    expect(judgeSkipLink([link('Skip', { target: '', exists: false, rendered: false, main: false }), main])).toMatchObject({ kind: 'broken', why: 'its href is just "#"' });
  });

  it('present: a link among the first three stops, by name or by pointing at <main>', () => {
    expect(judgeSkipLink([...nav(2), link('Zum Inhalt springen', { target: 'c', exists: true, rendered: true, main: true }), ...nav(6), main])).toMatchObject({ kind: 'ok' });
    expect(judgeSkipLink([link('Start reading', { target: 'main', exists: true, rendered: true, main: true }), ...nav(6), main])).toMatchObject({ kind: 'ok' });
    // A same-page link that is neither named like a skip link nor pointing at the main content does not count.
    expect(judgeSkipLink([link('Top', { target: 'top', exists: true, rendered: true, main: false }), ...nav(6), main])).toMatchObject({ kind: 'missing' });
  });
});

describe('formatKeyboard', () => {
  const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `link "L${i + 1}" [ref=e${i + 1}]`, box: { x: 10, y: 20 * i, width: 50, height: 16 } }));
  const input = (over: Partial<KbInput> = {}): KbInput => ({ tabId: 'tab-2', scope: 'whole page', documents: 1, stops: stops(3), end: { kind: 'complete' }, ms: 1600, problems: [], notes: [], ...over });

  it('a clean complete walk', () => {
    const text = formatKeyboard(input());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Keyboard walk of tab-2 (whole page): 3 Tab stops, back to the start, 1.6 s; no problems found. Focus and scroll restored.');
    expect(lines[1]).toBe('Focus order (page CSS px):');
    expect(lines[2]).toBe('1 link "L1" [ref=e1] (10,0)');
    expect(lines.at(-1)).toMatch(/^This walk uses only Tab and Shift\+Tab\./);
  });

  it('problems in the accessibility report shape, worst first, with refs, criterion and level', () => {
    const text = formatKeyboard(
      input({
        documents: 3,
        problems: [
          { id: 'focus-order', count: 1, items: ['a → b (jumps 900 px up)'] },
          { id: 'focus-not-visible', count: 10, items: Array.from({ length: 10 }, (_, i) => `button "B${i}" [ref=e${20 + i}]`) },
          { id: 'keyboard-trap', count: 1, what: 'Tab cycles inside group "Chat" [ref=e43] through 3 stops; Shift+Tab cannot leave it either', items: ['x; y; z'] },
        ],
      }),
    );
    expect(text).toContain('Keyboard walk of tab-2 (whole page, 3 documents): 3 Tab stops, back to the start, 1.6 s; 12 problems in 3 checks, all fail WCAG A/AA.');
    const problems = text.split('\n').filter(l => l.startsWith('- '));
    expect(problems[0]).toBe('- critical keyboard-trap ×1 [WCAG 2.1.2 A]: Tab cycles inside group "Chat" [ref=e43] through 3 stops; Shift+Tab cannot leave it either. Fix: let Tab move past the last control (no preventDefault on Tab), or close the widget with Escape and say so.');
    expect(problems[1]).toMatch(/^- serious focus-not-visible ×10 \[WCAG 2\.4\.7 AA\]: nothing shows where focus is\. Fix: /);
    expect(problems[2]).toMatch(/^- moderate focus-order ×1 \[WCAG 2\.4\.3 A\]/);
    expect(text).toContain('  button "B0" [ref=e20]; button "B1" [ref=e21]; button "B2" [ref=e22]; button "B3" [ref=e23]; button "B4" [ref=e24]; button "B5" [ref=e25]; button "B6" [ref=e26]; button "B7" [ref=e27]; +2 more');
    expect(text).toContain('A column layout can make an upward jump correct');
  });

  it('caps the focus order at 40 stops', () => {
    const text = formatKeyboard(input({ stops: stops(250), end: { kind: 'limit' }, ms: 9700, problems: [{ id: 'focus-order', count: 2, items: ['a', 'b'] }] }));
    expect(text.split('\n')[0]).toBe(
      'Keyboard walk of tab-2 (whole page): stopped after 250 Tab stops (the limit), 9.7 s, before getting back to the start. Unreachable elements and the skip link are not checked on an incomplete walk. Walk one region at a time (ref/selector of a section). 2 problems so far. Focus and scroll restored.',
    );
    expect(text).toContain(`Focus order (page CSS px): first ${MAX_LISTED_STOPS} of 250`);
    expect(text).toContain('40 link "L40" [ref=e40]');
    expect(text).not.toContain('41 link "L41"');
    expect(text).toContain('… 210 more stops (pass a region\'s ref/selector to list them).');
    expect(text.length).toBeLessThan(5000);
  });

  it('time limit, trap, region, modal and empty-region heads', () => {
    expect(formatKeyboard(input({ stops: stops(143), end: { kind: 'time' }, ms: 30_000 })).split('\n')[0]).toContain('stopped after 30.0 s (the time limit) at stop 143.');
    expect(formatKeyboard(input({ end: { kind: 'trap', stop: 2 } })).split('\n')[0]).toContain('stopped at a keyboard trap (stop 2); later stops and unreachable elements are not checked.');
    expect(formatKeyboard(input({ scope: 'only group "Menu" [ref=e4]', end: { kind: 'left-region' } })).split('\n')[0]).toBe(
      'Keyboard walk of tab-2 (only group "Menu" [ref=e4]): 3 Tab stops until focus left it, 1.6 s; no problems found. Focus and scroll restored.',
    );
    expect(formatKeyboard(input({ scope: 'only dialog "Delete project?" [ref=e20]', end: { kind: 'modal' } })).split('\n')[0]).toBe(
      'Keyboard walk of tab-2 (only dialog "Delete project?" [ref=e20]): 3 Tab stops; focus stays inside the modal dialog, as it should (check that Escape closes it). No problems found. Focus and scroll restored.',
    );
    expect(formatKeyboard(input({ stops: [], end: { kind: 'empty', next: 'link "Home" [ref=e1]' } })).split('\n')[0]).toContain('no Tab stop inside it (Tab from its start went to link "Home" [ref=e1])');
  });

  it('stop details, notes, page changes and a failed restore', () => {
    const text = formatKeyboard(
      input({
        stops: [{ label: 'textbox "Email" [ref=e1]', box: { x: 40, y: 2210, width: 10, height: 10 }, tabindex: 3, scripted: true }, { label: 'button "Chat" [ref=e2]', frame: 'the frame http://localhost:5174/chat.html' }],
        notes: ['Stop 1 was focused by script.'],
        pageChanges: 4,
        notRestored: 'the page navigated',
      }),
    );
    expect(text).toContain('1 textbox "Email" [ref=e1] (40,2210) tabindex=3 (focused by script)');
    expect(text).toContain('2 button "Chat" [ref=e2] in the frame http://localhost:5174/chat.html');
    expect(text).toContain('Focus could not be restored: the page navigated.');
    expect(text).toContain('The page changed while Tab was pressed (4 DOM changes)');
    expect(text).toContain('Stop 1 was focused by script.');
  });

  it('no Tab stops, and a walk stopped inside a container that cannot be seen into', () => {
    expect(formatKeyboard(input({ stops: [], end: { kind: 'none' } })).split('\n')[0]).toBe(
      'Keyboard walk of tab-2 (whole page): no Tab stops: nothing on the page takes focus with Tab, 1.6 s; no problems found. Focus and scroll restored.',
    );
    const head = formatKeyboard(input({ end: { kind: 'opaque', label: '<x-c> [ref=e3] (a closed shadow root)', presses: 50 } })).split('\n')[0];
    expect(head).toContain('stopped after 50 Tab presses inside <x-c> [ref=e3] (a closed shadow root), whose inside cannot be inspected (Shift+Tab leaves it, so it is not a trap)');
  });

  it('stops inside an opaque container are folded into it and counted', () => {
    const text = formatKeyboard(
      input({ stops: [{ label: 'button "First" [ref=e1]' }, { label: '<x-c> [ref=e2]', inside: { count: 2, what: 'a closed shadow root' } }, { label: 'button "Last" [ref=e3]' }] }),
    );
    expect(text.split('\n')[0]).toContain(': 5 Tab stops, back to the start');
    expect(text).toContain('2 <x-c> [ref=e2], then 2 more stops inside it (a closed shadow root: not inspected)');
    expect(text).toContain('5 button "Last" [ref=e3]');
  });

  it('a large trap lists 8 members and "+N more", and the whole result stays under 5,000 characters', () => {
    const members = Array.from({ length: 100 }, (_, i) => `link "Menu entry number ${i + 1}" [ref=e${i + 10}]`);
    const text = formatKeyboard(
      input({
        stops: stops(101).map((s, i) => ({ ...s, label: `link "Menu entry number ${i}" with a long name for this test [ref=e${i + 10}]` })),
        end: { kind: 'trap', stop: 2 },
        problems: [{ id: 'keyboard-trap', count: 1, what: 'Tab cycles inside navigation "Big menu" [ref=e9] through 100 stops; Shift+Tab cannot leave it either', items: members, itemTotal: 100 }],
      }),
    );
    expect(text).toContain('link "Menu entry number 8" [ref=e17]; +92 more');
    expect(text).not.toContain('Menu entry number 9" [ref=e18];');
    expect(text.length).toBeLessThanOrEqual(5000);
    const huge = formatKeyboard(input({ problems: Array.from({ length: 40 }, (_, i) => ({ id: 'focus-order' as const, count: 1, what: 'x'.repeat(200), items: ['y'.repeat(400)] })).slice(0, 40) }));
    expect(huge.length).toBeLessThanOrEqual(5000);
    expect(huge).toMatch(/cut at 5000 characters/);
  });

  it('the time-limit head says when the tab is in the background', () => {
    expect(formatKeyboard(input({ stops: stops(20), end: { kind: 'time' }, ms: 30_000, background: true })).split('\n')[0]).toContain('the tab is in the background, where VS Code paints it rarely');
  });
});

describe('pixel comparison (decodePng, changedPixels)', () => {
  /** Encodes an RGB(A) image as a PNG, filtering row y with filters[y % filters.length] (0 None … 4 Paeth). */
  function encode(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number) => number[], filters = [0, 1, 2, 3, 4], depth = 8): Uint8Array {
    const stride = width * channels;
    const img = Array.from({ length: height }, (_, y) => Uint8Array.from(Array.from({ length: width }, (_, x) => pixel(x, y).slice(0, channels)).flat()));
    const raw: number[] = [];
    for (let y = 0; y < height; y++) {
      const f = filters[y % filters.length]!;
      raw.push(f);
      for (let x = 0; x < stride; x++) {
        const v = img[y]![x]!;
        const a = x >= channels ? img[y]![x - channels]! : 0;
        const b = y > 0 ? img[y - 1]![x]! : 0;
        const c = x >= channels && y > 0 ? img[y - 1]![x - channels]! : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
        raw.push((v - pred) & 255);
      }
    }
    const chunk = (type: string, body: Uint8Array) => {
      const out = Buffer.alloc(12 + body.length);
      out.writeUInt32BE(body.length, 0);
      out.write(type, 4, 'latin1');
      Buffer.from(body).copy(out, 8);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = depth;
    ihdr[9] = channels === 4 ? 6 : 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', new Uint8Array())]);
  }
  const gradient = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y * 13) & 255, 255];

  it('decodes RGBA and RGB with all five filters', () => {
    for (const channels of [3, 4] as const) {
      const img = decodePng(encode(9, 10, channels, gradient), inflateSync)!;
      expect(img).toMatchObject({ width: 9, height: 10, channels });
      for (const [x, y] of [[0, 0], [8, 9], [4, 3], [7, 4]] as const) {
        expect([...img.data.subarray((y * 9 + x) * channels, (y * 9 + x) * channels + 3)]).toEqual(gradient(x, y).slice(0, 3));
      }
    }
  });

  it('refuses what it cannot read', () => {
    expect(decodePng(encode(4, 4, 4, gradient, [0], 16), inflateSync)).toBeUndefined();
    expect(decodePng(new Uint8Array([1, 2, 3]), inflateSync)).toBeUndefined();
  });

  it('a stray anti-aliased pixel is not a change; a focus ring is', () => {
    const white = () => [255, 255, 255, 255];
    const base = decodePng(encode(40, 20, 4, white), inflateSync)!;
    // What a real capture showed: one pixel of the neighbouring link's text at (250,250,255) instead of white.
    const noise = decodePng(encode(40, 20, 4, (x, y) => (x === 15 && y === 12 ? [250, 250, 255, 255] : white())), inflateSync)!;
    expect(changedPixels(base, noise)).toBe(0);
    const ring = decodePng(encode(40, 20, 4, (x, y) => (y === 2 && x >= 2 && x < 38 ? [0, 0, 255, 255] : white())), inflateSync)!;
    expect(changedPixels(base, ring)).toBe(36);
    expect(changedPixels(base, ring)! >= MIN_CHANGED_PIXELS).toBe(true);
    expect(changedPixels(base, decodePng(encode(41, 20, 4, white), inflateSync)!)).toBeUndefined();
  });
});
