// Formats axe-core results for an agent: grouped by rule, worst first, capped, each element with its
// ref and each rule with a one-line fix. Pure, unit-tested.
import { clip } from './ringBuffer';

export interface AxeNode {
  /** e.g. 'textbox "Email" [ref=e5]', or the element's HTML when it has no ref. */
  label: string;
  /** Extra detail for this element (contrast ratio and colours). */
  detail?: string;
}

export interface AxeRule {
  id: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  help: string;
  /** Elements that fail it (all, not only the ones described in `nodes`). */
  count: number;
  nodes: AxeNode[];
  /** First check message of the first element, for rules without a fix below. */
  message?: string;
  /** Frame it was found in, when not the top document. */
  frame?: string;
}

export interface AxeReview {
  id: string;
  count: number;
  help: string;
}

export interface A11yInput {
  tabId: string;
  scope: string;
  version: string;
  frames: number;
  violations: AxeRule[];
  incomplete: AxeReview[];
  /** Frames that could not be checked, with why. */
  skipped: string[];
}

const IMPACT = ['critical', 'serious', 'moderate', 'minor'];

/** How to fix the rules an agent meets most, in a line each. Others use axe's own check message. */
const FIXES: Record<string, string> = {
  label: 'give it a <label for>, or aria-label / aria-labelledby',
  'select-name': 'give it a <label for>, or aria-label / aria-labelledby',
  'button-name': 'give it text, or aria-label for an icon button',
  'link-name': 'give it text or aria-label; an image link needs alt text on the image',
  'image-alt': 'add alt text (alt="" if it is decorative)',
  'input-image-alt': 'add alt text that says what the button does',
  'svg-img-alt': 'add a <title> or aria-label',
  'role-img-alt': 'add aria-label or aria-labelledby',
  'object-alt': 'add a text alternative (aria-label or title)',
  'input-button-name': 'give it a value or aria-label',
  'frame-title': 'give the <iframe> a title',
  'document-title': 'add a <title>',
  'html-has-lang': 'add lang="…" (the page language) to <html>',
  'html-lang-valid': 'use a valid language code in <html lang>',
  'heading-order': 'heading levels should rise by one (an h2 after an h1, not an h4)',
  'empty-heading': 'give the heading text, or remove it',
  'page-has-heading-one': 'add one <h1> naming the page',
  'landmark-one-main': 'put the main content in <main>',
  'landmark-unique': 'give landmarks of the same kind distinct aria-labels',
  'duplicate-id-aria': 'make the id unique: labels and ARIA references reach only the first element with it',
  'duplicate-id-active': 'make the id unique',
  'nested-interactive': 'do not put controls inside other controls (a button inside a link or button)',
  list: '<ul>/<ol> may contain only <li> (and script/template)',
  listitem: 'put <li> inside a <ul> or <ol>',
  'definition-list': '<dl> may contain only <dt>/<dd> groups',
  'autocomplete-valid': 'use a valid autocomplete token (email, name, current-password, ...)',
  'aria-hidden-focus': 'take focusable elements out of the tab order (tabindex="-1") or drop aria-hidden',
  'aria-hidden-body': 'remove aria-hidden from <body>',
  'meta-viewport': 'allow zooming: remove user-scalable=no and maximum-scale below 5',
  tabindex: 'avoid tabindex above 0; order elements in the DOM instead',
  'label-title-only': 'add a visible <label>; title alone is not enough',
  'form-field-multiple-labels': 'keep one label per field',
  'target-size': 'make the target at least 24×24 px or keep 24 px around it',
  'scrollable-region-focusable': 'make the scrollable area focusable (tabindex="0") or put a focusable element inside',
  'link-in-text-block': 'underline links in text, or give them 3:1 contrast with the text around them',
  'color-contrast': 'darken the text or lighten its background (or the reverse)',
  'color-contrast-enhanced': 'raise the contrast to 7:1 (4.5:1 for large text)',
  'image-redundant-alt': 'do not repeat the surrounding text in alt',
  'presentation-role-conflict': 'remove the focusability or global ARIA from elements marked presentational',
  'aria-allowed-role': 'use a role this element may take, or a different element',
  'aria-dialog-name': 'give the dialog aria-label or aria-labelledby',
  'aria-toggle-field-name': 'give the toggle a name (text, aria-label)',
  'aria-input-field-name': 'give the field aria-label or aria-labelledby',
  'aria-command-name': 'give it text or aria-label',
  'aria-progressbar-name': 'give the progress bar aria-label',
  'aria-tooltip-name': 'give the tooltip text',
  'aria-meter-name': 'give the meter aria-label',
  'empty-table-header': 'give the header cell text',
  'th-has-data-cells': 'header cells must label data cells',
  'td-headers-attr': 'headers="…" must point at header cells of the same table',
  bypass: 'add a "skip to content" link or landmarks',
  region: 'put content inside landmarks (<main>, <nav>, ...)',
  'skip-link': 'the skip link must point at an element on the page',
  'video-caption': 'add captions (<track kind="captions">)',
  'select-label': 'give the select a label',
  'summary-name': 'give the <summary> text',
};

export const RULE_DOCS = (version: string) => `https://dequeuniversity.com/rules/axe/${version.split('.').slice(0, 2).join('.')}/`;

const MAX_RULES = 12;
const MAX_NODES = 4;

export function formatA11y(r: A11yInput): string {
  const total = r.violations.reduce((n, v) => n + v.count, 0);
  const frames = r.frames > 1 ? `, ${r.frames} documents` : '';
  const head = `Accessibility of ${r.tabId} (${r.scope}${frames}; axe-core ${r.version}, WCAG 2.2 A/AA and best practices)`;
  const lines: string[] = [];
  if (total === 0) lines.push(`${head}: no problems found.`);
  else lines.push(`${head}: ${total} problem${total === 1 ? '' : 's'} in ${r.violations.length} rule${r.violations.length === 1 ? '' : 's'}, worst first.`);
  const sorted = [...r.violations].sort((a, b) => rank(a.impact) - rank(b.impact) || b.count - a.count);
  for (const v of sorted.slice(0, MAX_RULES)) {
    const fix = FIXES[v.id] ?? (v.message ? clip(v.message, 160) : clip(v.help, 160));
    const where = v.frame ? ` (in ${v.frame})` : '';
    lines.push(`- ${v.impact ?? 'minor'} ${v.id} ×${v.count}${where}: ${clip(v.help, 120)}. Fix: ${fix}.`);
    const shown = v.nodes.slice(0, MAX_NODES).map(n => (n.detail ? `${n.label} ${n.detail}` : n.label));
    const more = v.count - shown.length;
    if (shown.length) lines.push(`  ${shown.join('; ')}${more > 0 ? `; +${more} more` : ''}`);
  }
  if (sorted.length > MAX_RULES) lines.push(`- ${sorted.length - MAX_RULES} more rules: ${sorted.slice(MAX_RULES).map(v => `${v.id} ×${v.count}`).join(', ')}.`);
  if (r.incomplete.length) {
    const items = r.incomplete
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map(i => `${i.id} ×${i.count}`);
    lines.push(`Needs a human look (axe could not decide, e.g. text over images): ${items.join(', ')}${r.incomplete.length > 6 ? ', …' : ''}.`);
  }
  for (const s of r.skipped.slice(0, 3)) lines.push(`Not checked: ${s}.`);
  if (total > 0) lines.push(`Rule details: ${RULE_DOCS(r.version)}<rule>. Automated checks find only part of the problems (keyboard use, focus order and meaning need a person).`);
  return lines.join('\n');
}

function rank(impact: string | null): number {
  const i = IMPACT.indexOf(impact ?? 'minor');
  return i < 0 ? IMPACT.length : i;
}

/** "2.3:1, needs 4.5:1 (#999999 on #ffffff, 12pt)" from axe's color-contrast data. */
export function contrastDetail(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { contrastRatio?: number; expectedContrastRatio?: string; fgColor?: string; bgColor?: string; fontSize?: string; fontWeight?: string };
  if (typeof d.contrastRatio !== 'number' || !d.contrastRatio) return undefined;
  const ratio = Math.round(d.contrastRatio * 100) / 100;
  const colours = d.fgColor && d.bgColor ? ` ${d.fgColor} on ${d.bgColor}` : '';
  const size = d.fontSize ? `, ${d.fontSize}${d.fontWeight === 'bold' ? ' bold' : ''}` : '';
  return `(${ratio}:1, needs ${d.expectedContrastRatio ?? '4.5:1'};${colours}${size})`;
}
