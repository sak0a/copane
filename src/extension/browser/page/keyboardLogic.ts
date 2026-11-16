// The decisions of the keyboard walk (keyboard.ts), kept free of CDP: when the walk is over (back at
// the start, stuck, cycling), whether focus showed, which steps jump against the reading order, and
// whether the skip link is missing or broken. Pure, unit-tested.

/** A box in page CSS px (document coordinates of the top page). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the walk saw at each step, by element key (`<target>#<backendNodeId>`). */
export type StepVerdict =
  | { kind: 'continue' }
  /** Focus came back to stop 1: one full round. */
  | { kind: 'wrap' }
  /** Focus left the document (or the region): the end of the order. */
  | { kind: 'left' }
  /** Tab did not move focus (pressed three times on the same element). */
  | { kind: 'stuck'; index: number }
  /** Focus went round `length` stops starting at stop `start` (0-based) twice in the same order. */
  | { kind: 'cycle'; start: number; length: number };

/**
 * Follows the keys of the focused element after each Tab and says when the walk is over. A key seen
 * before (not stop 1) may be a cycle; it counts as one only when the same stops follow again in the
 * same order, so a page that merely sends focus back once (a roving tabindex, a script) keeps going.
 */
export class WalkTracker {
  /** Distinct stops in order (a repeat that turns out not to be a cycle is listed again). */
  readonly stops: string[] = [];
  private pending: { start: number; length: number; matched: number } | undefined;
  private sameAsLast = 0;

  push(key: string | undefined): StepVerdict {
    if (key === undefined) return { kind: 'left' };
    const n = this.stops.length;
    if (n > 0 && key === this.stops[0]) return { kind: 'wrap' };
    if (n > 0 && key === this.stops[n - 1]) {
      // Tab left focus where it was. Once may be a dropped key press; twice more is a captured Tab.
      if (++this.sameAsLast >= 2) return { kind: 'stuck', index: n - 1 };
      return { kind: 'continue' };
    }
    this.sameAsLast = 0;
    if (this.pending) {
      const { start, length, matched } = this.pending;
      const expected = this.stops[start + ((matched + 1) % length)];
      if (key === expected) {
        this.pending.matched++;
        if (this.pending.matched === length) {
          // Drop the second round from the list: the stops are the first round only.
          this.stops.splice(n - length);
          return { kind: 'cycle', start, length };
        }
        this.stops.push(key);
        return { kind: 'continue' };
      }
      this.pending = undefined;
    }
    const seen = this.stops.indexOf(key);
    if (seen > 0) this.pending = { start: seen, length: n - seen, matched: 0 };
    this.stops.push(key);
    return { kind: 'continue' };
  }
}

// ---------------------------------------------------------------- focus visibility

/** Computed style of one element or pseudo-element, as STYLE_SIGNATURE reads it (null = absent). */
export interface RawStyle {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  outlineOffset: string;
  boxShadow: string;
  /** Top, right, bottom, left. */
  borderWidths: string[];
  borderStyles: string[];
  borderColors: string[];
  backgroundColor: string;
  backgroundImage: string;
  color: string;
  textDecoration: string;
  opacity: string;
  transform: string;
  /** `content` of a pseudo-element ('none' for the element itself). */
  content: string;
}

const px = (v: string) => Number.parseFloat(v) || 0;

/**
 * The parts of a style that show focus, normalized so that invisible differences do not count: an
 * outline whose style is none or whose width is 0, a border side without width. A pseudo-element that
 * is not rendered is null.
 */
export function signatureOf(style: RawStyle | null): string {
  if (!style) return '-';
  const parts: string[] = [];
  if (style.outlineStyle !== 'none' && style.outlineStyle !== 'hidden' && px(style.outlineWidth) > 0) {
    parts.push(`outline:${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`);
  }
  if (style.boxShadow && style.boxShadow !== 'none') parts.push(`shadow:${style.boxShadow}`);
  for (let i = 0; i < 4; i++) {
    const width = style.borderWidths[i] ?? '0px';
    const kind = style.borderStyles[i] ?? 'none';
    if (px(width) > 0 && kind !== 'none' && kind !== 'hidden') parts.push(`border${i}:${width} ${kind} ${style.borderColors[i] ?? ''}`);
  }
  parts.push(`bg:${style.backgroundColor} ${style.backgroundImage}`, `color:${style.color}`, `text:${style.textDecoration}`, `opacity:${style.opacity}`, `transform:${style.transform}`, `content:${style.content}`);
  return parts.join('|');
}

/**
 * Whether anything that shows focus differs between the element focused and unfocused: itself, its
 * ::before and ::after, and two ancestors (which catches :focus-within).
 */
export function focusShows(focused: Array<RawStyle | null>, unfocused: Array<RawStyle | null>): boolean {
  const n = Math.max(focused.length, unfocused.length);
  for (let i = 0; i < n; i++) if (signatureOf(focused[i] ?? null) !== signatureOf(unfocused[i] ?? null)) return true;
  return false;
}

// ---------------------------------------------------------------- focus order

/** What the order checks need to know about a stop. */
export interface OrderStop {
  label: string;
  box: Box | undefined;
  /** Positive tabindex only. */
  tabindex?: number;
  /** position: fixed or sticky, on the element or an ancestor. */
  fixed?: boolean;
  /** The document the stop is in ('top' or a frame); jumps between documents are not judged. */
  doc: string;
}

export interface OrderJump {
  /** e.g. 'button "Search" [ref=e40] (1180,18) → textbox "Email" [ref=e41] (40,2210) (tabindex=3)' */
  text: string;
  kind: 'tabindex' | 'up' | 'back';
}

export const UP_JUMP_PX = 200;
const SAME_ROW_PX = 10;
const BACK_PX = 20;
const MAX_JUMPS = 5;

export const at = (box: Box | undefined) => (box ? ` (${Math.round(box.x)},${Math.round(box.y)})` : '');

/**
 * Steps that go against the reading order: every positive tabindex (it moves the element ahead of
 * the page), a step to something more than 200 px higher up, and in a left-to-right page a step back
 * to the left within the same row. Fixed and sticky elements and steps between documents are not
 * judged (their position says nothing about reading order). All found are counted, five are shown.
 */
export function orderJumps(stops: OrderStop[], ltr: boolean): { count: number; shown: OrderJump[] } {
  const all: OrderJump[] = [];
  for (let i = 0; i < stops.length; i++) {
    const b = stops[i]!;
    const a = i > 0 ? stops[i - 1] : undefined;
    if (b.tabindex !== undefined && b.tabindex > 0) {
      all.push({ kind: 'tabindex', text: a ? `${a.label}${at(a.box)} → ${b.label}${at(b.box)} (tabindex=${b.tabindex})` : `${b.label}${at(b.box)} comes first (tabindex=${b.tabindex})` });
      continue;
    }
    if (!a || !a.box || !b.box || a.fixed || b.fixed || a.doc !== b.doc) continue;
    const up = a.box.y - (b.box.y + b.box.height);
    if (up > UP_JUMP_PX) {
      all.push({ kind: 'up', text: `${a.label}${at(a.box)} → ${b.label}${at(b.box)} (jumps ${Math.round(a.box.y - b.box.y)} px up)` });
      continue;
    }
    if (ltr && Math.abs(b.box.y - a.box.y) < SAME_ROW_PX && b.box.x + b.box.width < a.box.x - BACK_PX) {
      all.push({ kind: 'back', text: `${a.label}${at(a.box)} → ${b.label}${at(b.box)} (back to the left in the same row)` });
    }
  }
  return { count: all.length, shown: all.slice(0, MAX_JUMPS) };
}

// ---------------------------------------------------------------- skip link

/** What FOCUS_FACTS says about a same-page link (href="#…"), for the skip-link check. */
export interface SkipFacts {
  /** The id after '#' ('' for "#"). */
  target: string;
  /** An element with that id (or <a name>) exists. */
  exists: boolean;
  /** It is rendered (not display:none, not zero-size). */
  rendered: boolean;
  /** It is, contains or is inside <main> / [role=main]. */
  main: boolean;
}

export interface SkipStop {
  label: string;
  /** Accessible name. */
  name: string;
  skip?: SkipFacts;
  /** Inside <main> or [role=main]. */
  inMain: boolean;
}

export const SKIP_NAME = /skip|jump to|main content|zum inhalt|aller au contenu|saltar/i;
const SKIP_WITHIN = 3;
const SKIP_NEEDED_AFTER = 5;

export type SkipVerdict =
  | { kind: 'ok'; label: string }
  | { kind: 'missing'; before: number; firstMain: string }
  | { kind: 'broken'; label: string; why: string }
  /** No main landmark and no skip link: where the content starts is unknown. */
  | { kind: 'unknown' }
  /** Few enough stops before the main content that no skip link is needed. */
  | { kind: 'not-needed' };

/**
 * The skip-link check (WCAG 2.4.1): among the first three stops, a same-page link named like a skip
 * link or pointing at the main content. Missing when there is none and at least five stops come
 * before the main content; broken when its target does not exist or is not rendered. The link is never
 * activated (that would change the URL and the history).
 */
export function judgeSkipLink(stops: SkipStop[]): SkipVerdict {
  const link = stops.slice(0, SKIP_WITHIN).find(s => s.skip && (SKIP_NAME.test(s.name) || (s.skip.exists && s.skip.main)));
  if (link) {
    const t = link.skip!;
    if (!t.target) return { kind: 'broken', label: link.label, why: 'its href is just "#"' };
    if (!t.exists) return { kind: 'broken', label: link.label, why: `nothing on the page has id "${t.target}"` };
    if (!t.rendered) return { kind: 'broken', label: link.label, why: `its target #${t.target} is hidden (display: none or no size)` };
    return { kind: 'ok', label: link.label };
  }
  const first = stops.findIndex(s => s.inMain);
  if (first < 0) return { kind: 'unknown' };
  if (first < SKIP_NEEDED_AFTER) return { kind: 'not-needed' };
  return { kind: 'missing', before: first, firstMain: stops[first]!.label };
}
