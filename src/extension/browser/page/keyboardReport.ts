// Formats a keyboard walk (keyboard.ts) for an agent: a head saying how far the walk got and whether
// focus was put back, the focus order (capped), and one line per problem in the shape of the
// accessibility report (a11yReport.ts): impact, rule, WCAG criterion and level, what, fix, then the
// elements with their refs. Pure, unit-tested.
import { at, type Box } from './keyboardLogic';

export type KbRuleId = 'keyboard-trap' | 'not-focusable' | 'focus-not-visible' | 'skip-link-missing' | 'skip-link-broken' | 'focus-order';

interface Rule {
  impact: 'critical' | 'serious' | 'moderate';
  wcag: string;
  level: 'A' | 'AA';
  what: string;
  fix: string;
}

export const KB_RULES: Record<KbRuleId, Rule> = {
  'keyboard-trap': {
    impact: 'critical',
    wcag: '2.1.2',
    level: 'A',
    what: 'Tab cannot leave this part of the page',
    fix: 'let Tab move past the last control (no preventDefault on Tab), or close the widget with Escape and say so',
  },
  'not-focusable': {
    impact: 'serious',
    wcag: '2.1.1',
    level: 'A',
    what: 'looks interactive but Tab never reaches it',
    fix: 'use a <button> or <a href>; otherwise add tabindex="0", a role and Enter/Space handling',
  },
  'focus-not-visible': {
    impact: 'serious',
    wcag: '2.4.7',
    level: 'AA',
    what: 'nothing shows where focus is',
    fix: 'style :focus-visible (e.g. outline: 2px solid; offset 2px); never outline: none without a replacement',
  },
  'skip-link-missing': {
    impact: 'moderate',
    wcag: '2.4.1',
    level: 'A',
    what: 'no skip link',
    fix: 'add a first link "Skip to content" to <main id="…">, visible on focus',
  },
  'skip-link-broken': {
    impact: 'moderate',
    wcag: '2.4.1',
    level: 'A',
    what: 'the skip link goes nowhere',
    fix: 'point it at the id of the main content (e.g. <main id="content">) and keep that element rendered',
  },
  'focus-order': {
    impact: 'moderate',
    wcag: '2.4.3',
    level: 'A',
    what: 'focus jumps against the reading order',
    fix: 'remove tabindex > 0 and order the DOM the way the page reads',
  },
};

export interface KbProblem {
  id: KbRuleId;
  /** All elements (or steps) with the problem, not only the listed ones. */
  count: number;
  /** What is wrong, when more specific than the rule's own text. */
  what?: string;
  /** The elements, e.g. 'button "Search" [ref=e40]'; at most 8 are shown. */
  items: string[];
}

export interface KbStopLine {
  /** e.g. 'link "Products" [ref=e31]' */
  label: string;
  box?: Box;
  /** Positive tabindex. */
  tabindex?: number;
  /** e.g. 'the frame http://localhost:5174/chat.html', when not in the top document. */
  frame?: string;
  /** Focused by script instead of Tab (the start of the walk). */
  scripted?: boolean;
}

export type KbEnd =
  /** Back at stop 1 (or focus left the page): every stop was seen. */
  | { kind: 'complete' }
  /** A region walk: focus moved out of the region. */
  | { kind: 'left-region' }
  /** A modal dialog keeps focus inside, as it should. */
  | { kind: 'modal' }
  | { kind: 'limit' }
  | { kind: 'time' }
  /** Stopped at a keyboard trap found at this stop (1-based). */
  | { kind: 'trap'; stop: number }
  /** A region with no Tab stop: Tab from its start went to `next` (or nowhere). */
  | { kind: 'empty'; next?: string };

export interface KbInput {
  tabId: string;
  /** 'whole page' or 'only dialog "Delete?" [ref=e20]' */
  scope: string;
  /** Documents the stops came from. */
  documents: number;
  stops: KbStopLine[];
  end: KbEnd;
  ms: number;
  problems: KbProblem[];
  /** Undefined when focus and scroll were put back; else why not. */
  notRestored?: string;
  /** Extra lines (how the walk started, what was not checked). */
  notes: string[];
  /** DOM changes in the page while Tab was pressed (focus handlers). */
  pageChanges?: number;
}

export const MAX_LISTED_STOPS = 40;
const MAX_ITEMS = 8;
const MAX_CHARS = 5000;
const IMPACT = ['critical', 'serious', 'moderate'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function problemSummary(problems: KbProblem[]): { total: number; text: string } {
  const total = problems.reduce((n, p) => n + p.count, 0);
  if (!total) return { total, text: 'no problems found' };
  return { total, text: `${plural(total, 'problem')} in ${plural(problems.length, 'check')}, all fail WCAG A/AA` };
}

function head(r: KbInput): string {
  const docs = r.documents > 1 ? `, ${r.documents} documents` : '';
  const what = `Keyboard walk of ${r.tabId} (${r.scope}${docs})`;
  const seconds = `${(r.ms / 1000).toFixed(1)} s`;
  const n = r.stops.length;
  const { total, text } = problemSummary(r.problems);
  const restored = r.notRestored ? `Focus could not be restored: ${r.notRestored}.` : 'Focus and scroll restored.';
  const incomplete = 'Unreachable elements and the skip link are not checked on an incomplete walk.';
  const soFar = `${plural(total, 'problem')} so far.`;
  switch (r.end.kind) {
    case 'complete':
      return `${what}: ${plural(n, 'Tab stop')}, back to the start, ${seconds}; ${text}. ${restored}`;
    case 'left-region':
      return `${what}: ${plural(n, 'Tab stop')} until focus left it, ${seconds}; ${text}. ${restored}`;
    case 'modal': {
      const verdict = total ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : 'No problems found.';
      return `${what}: ${plural(n, 'Tab stop')}; focus stays inside the modal dialog, as it should (check that Escape closes it). ${verdict} ${restored}`;
    }
    case 'limit':
      return `${what}: stopped after ${n} Tab stops (the limit), ${seconds}, before getting back to the start. ${incomplete} Walk one region at a time (ref/selector of a section). ${soFar} ${restored}`;
    case 'time':
      return `${what}: stopped after ${seconds} (the time limit) at stop ${n}. ${incomplete} Walk one region at a time (ref/selector of a section). ${soFar} ${restored}`;
    case 'trap':
      return `${what}: ${plural(n, 'Tab stop')}, ${seconds}; stopped at a keyboard trap (stop ${r.end.stop}); later stops and unreachable elements are not checked. ${plural(total, 'problem')}. ${restored}`;
    case 'empty':
      return `${what}: no Tab stop inside it (Tab from its start went to ${r.end.next ?? 'nothing'}), ${seconds}; ${text}. ${restored}`;
  }
}

function stopLine(s: KbStopLine, i: number): string {
  const tabindex = s.tabindex ? ` tabindex=${s.tabindex}` : '';
  const frame = s.frame ? ` in ${s.frame}` : '';
  const scripted = s.scripted ? ' (focused by script)' : '';
  return `${i + 1} ${s.label}${at(s.box)}${tabindex}${frame}${scripted}`;
}

function problemLines(p: KbProblem): string[] {
  const rule = KB_RULES[p.id];
  const out = [`- ${rule.impact} ${p.id} ×${p.count} [WCAG ${rule.wcag} ${rule.level}]: ${p.what ?? rule.what}. Fix: ${rule.fix}.`];
  const shown = p.items.slice(0, MAX_ITEMS);
  const more = p.count - shown.length;
  if (shown.length) out.push(`  ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}`);
  return out;
}

export function formatKeyboard(r: KbInput): string {
  for (const listed of [MAX_LISTED_STOPS, 20, 10]) {
    const text = compose(r, listed);
    if (text.length <= MAX_CHARS || listed === 10) return text;
  }
  return compose(r, 10);
}

function compose(r: KbInput, listed: number): string {
  const lines = [head(r)];
  const n = r.stops.length;
  if (n) {
    lines.push(n > listed ? `Focus order (page CSS px): first ${listed} of ${n}` : 'Focus order (page CSS px):');
    r.stops.slice(0, listed).forEach((s, i) => lines.push(stopLine(s, i)));
    if (n > listed) lines.push(`… ${n - listed} more stops (pass a region's ref/selector to list them).`);
  }
  const problems = [...r.problems].filter(p => p.count > 0).sort((a, b) => IMPACT.indexOf(KB_RULES[a.id].impact) - IMPACT.indexOf(KB_RULES[b.id].impact));
  for (const p of problems) lines.push(...problemLines(p));
  lines.push(...r.notes);
  if (r.pageChanges) lines.push(`The page changed while Tab was pressed (${plural(r.pageChanges, 'DOM change')}): focus handlers may have opened menus or tooltips; only focus, scroll and selection were put back.`);
  let footer = 'This walk uses only Tab and Shift+Tab. Also try the controls themselves: Enter, Space, the arrows in menus and tabs, Escape in dialogs.';
  if (problems.some(p => p.id === 'focus-order' && p.items.some(i => i.includes('px up')))) footer += ' A column layout can make an upward jump correct; compare with how the page reads.';
  lines.push(footer);
  return lines.join('\n');
}
