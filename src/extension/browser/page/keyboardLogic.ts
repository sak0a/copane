// The decisions of the keyboard walk (keyboard.ts), kept free of CDP: when the walk is over and how it
// ended (back at the start, stuck, cycling, contained in a modal), whether focus showed, which steps
// jump against the reading order, and whether the skip link is missing or broken. Pure, unit-tested.

/** A box in page CSS px (document coordinates of the top page). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- the walk

/** What the walk saw after one Tab press. */
export interface Observed {
  /** `<target>#<backendNodeId>` of the focused element; undefined when nothing in the page has focus. */
  key: string | undefined;
  /** The page called preventDefault on that Tab's keydown. */
  captured?: boolean;
  /** The element is a container the walk cannot see into (a closed shadow root or frame it could not enter). */
  opaque?: boolean;
}

export type StepVerdict =
  | { kind: 'continue' }
  /** Focus came back to stop 1. */
  | { kind: 'wrap' }
  /** Focus left the document: the end of the order. */
  | { kind: 'left' }
  /** The page took the Tab key (preventDefault) and focus did not move. */
  | { kind: 'stuck'; index: number }
  /** Focus went round `length` stops starting at stop `start` (0-based) twice in the same order. */
  | { kind: 'cycle'; start: number; length: number }
  /** Focus stayed on one element for OPAQUE_LIMIT presses without the page taking the key. */
  | { kind: 'opaque'; index: number };

/** Presses on the same element, without the page taking Tab, after which the walk stops there. */
export const OPAQUE_LIMIT = 50;

/** The key of the n-th stop inside an opaque container (the container itself is n = 0). */
export const insideKey = (key: string, n: number) => (n ? `${key}~${n}` : key);

/** The container key and the position inside it of a key made by `insideKey`. */
export function splitInside(key: string): { key: string; inside: number } {
  const m = /^(.*)~(\d+)$/.exec(key);
  return m ? { key: m[1]!, inside: Number(m[2]) } : { key, inside: 0 };
}

/**
 * Follows what each Tab press focused and says when the walk is over.
 * - Focus staying on the same element is "Tab is captured" only when the page took the key
 *   (preventDefault). Inside a container the walk cannot see into, each press is one stop inside it;
 *   otherwise a press that did not move focus is ignored (a dropped key press). Either way the walk
 *   gives up on that element after OPAQUE_LIMIT presses.
 * - Back at stop 1 is a wrap.
 * - A key seen before (not stop 1) is a cycle only when the same stops follow again in the same
 *   order, so a page that merely sends focus back once (a roving tabindex, a script) keeps going.
 */
export class WalkTracker {
  /** Stops in order (stops inside an opaque container as `insideKey`). A repeat that is not a cycle is listed again. */
  readonly stops: string[] = [];
  private pending: { start: number; length: number; matched: number } | undefined;
  private lastRaw: string | undefined;
  private inside = 0;
  private still = 0;

  push(o: Observed): StepVerdict {
    const { key } = o;
    if (key === undefined) return { kind: 'left' };
    const n = this.stops.length;
    if (n > 0 && key === this.lastRaw) {
      if (o.captured) return { kind: 'stuck', index: n - 1 };
      if (!o.opaque) {
        if (++this.still >= OPAQUE_LIMIT) return { kind: 'opaque', index: n - 1 };
        return { kind: 'continue' };
      }
      if (++this.inside >= OPAQUE_LIMIT) return { kind: 'opaque', index: n - 1 };
      return this.next(insideKey(key, this.inside));
    }
    this.lastRaw = key;
    this.inside = 0;
    this.still = 0;
    if (n > 0 && key === this.stops[0]) return { kind: 'wrap' };
    return this.next(key);
  }

  private next(key: string): StepVerdict {
    const n = this.stops.length;
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

export type Outcome =
  | { kind: 'complete' }
  | { kind: 'left-region' }
  | { kind: 'modal' }
  | { kind: 'limit' }
  | { kind: 'time' }
  /** Nothing in the page takes focus with Tab. */
  | { kind: 'none' }
  /** A region with no Tab stop (focus went outside it at once). */
  | { kind: 'empty' }
  | { kind: 'stuck'; index: number }
  /** Tab goes round these stops (0-based) and never further; whether Shift+Tab gets out is checked next. */
  | { kind: 'cycle'; start: number; length: number }
  | { kind: 'opaque'; index: number };

export interface EndFacts {
  verdict: StepVerdict | { kind: 'outside' };
  /** Per stop: inside an open modal dialog (native or aria-modal). */
  inModal: boolean[];
  region: boolean;
  limitReached: boolean;
  /** For a region that wrapped: it holds the page's own first stop (then the wrap is the page's). */
  regionHoldsPageStart?: boolean;
  /** For a whole-page wrap: a real Tab stop exists that the walk never reached (so the wrap was a cycle). */
  missedTabStop?: boolean;
}

/**
 * How the walk ended. Coming back to stop 1 means the order is complete only if nothing was left out:
 * on the whole page no reachable stop may be missing, a region must hold the page's own start. Focus
 * kept inside a modal dialog (native or aria-modal) is contained, as it should be.
 */
export function decideEnd(f: EndFacts): Outcome {
  const v = f.verdict;
  const n = f.inModal.length;
  switch (v.kind) {
    case 'outside':
      return n ? { kind: 'left-region' } : { kind: 'empty' };
    case 'continue':
      return f.limitReached ? { kind: 'limit' } : { kind: 'time' };
    case 'stuck':
    case 'opaque':
      return v;
    case 'left':
      if (!n) return { kind: 'none' };
      return f.region ? { kind: 'left-region' } : { kind: 'complete' };
    case 'cycle':
      return f.inModal.slice(v.start, v.start + v.length).some(Boolean) ? { kind: 'modal' } : v;
    case 'wrap':
      if (!n) return { kind: 'none' };
      if (f.inModal.every(Boolean)) return { kind: 'modal' };
      if (f.region) return f.regionHoldsPageStart ? { kind: 'complete' } : { kind: 'cycle', start: 0, length: n };
      return f.missedTabStop ? { kind: 'cycle', start: 0, length: n } : { kind: 'complete' };
  }
}

/** Which page fact `decideEnd` needs for this verdict (each costs page work), if any. */
export function endNeeds(verdict: StepVerdict | { kind: 'outside' }, inModal: boolean[], region: boolean): 'region-start' | 'missed-stop' | undefined {
  if (verdict.kind !== 'wrap' || !inModal.length || inModal.every(Boolean)) return undefined;
  return region ? 'region-start' : 'missed-stop';
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
 * ::before and ::after, and two ancestors (which catches :focus-within). For a visually hidden form
 * control the same comparison runs over its labels, siblings and parent instead.
 */
export function focusShows(focused: Array<RawStyle | null>, unfocused: Array<RawStyle | null>): boolean {
  const n = Math.max(focused.length, unfocused.length);
  for (let i = 0; i < n; i++) if (signatureOf(focused[i] ?? null) !== signatureOf(unfocused[i] ?? null)) return true;
  return false;
}

/** An 8-bit RGB or RGBA image: `channels` bytes per pixel, rows top to bottom. */
export interface Pixels {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array;
}

/**
 * Decodes a PNG as the browser's screenshots are written: 8-bit RGB or RGBA, not interlaced (anything
 * else gives undefined). Inflating is passed in (`zlib.inflateSync`) so this stays free of Node.
 */
export function decodePng(png: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): Pixels | undefined {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) return undefined;
  const u32 = (i: number) => ((png[i]! << 24) | (png[i + 1]! << 16) | (png[i + 2]! << 8) | png[i + 3]!) >>> 0;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 4;
  const parts: Uint8Array[] = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = u32(pos);
    const type = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = u32(pos + 8);
      height = u32(pos + 12);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) return undefined;
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!width || !height || width * height > 4_000_000) return undefined;
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    joined.set(p, offset);
    offset += p.length;
  }
  const raw = inflate(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return undefined;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels]! : 0;
      const b = y > 0 ? data[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? data[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/** A pixel counts as changed when a colour channel moved by more than this (anti-aliasing stays below). */
export const PIXEL_DELTA = 32;
/** Changed pixels needed before focus counts as shown in the picture (a stray anti-aliased pixel does not). */
export const MIN_CHANGED_PIXELS = 4;

/** Pixels whose colour changed noticeably between two images of the same size; undefined when the sizes differ. */
export function changedPixels(a: Pixels, b: Pixels): number | undefined {
  if (a.width !== b.width || a.height !== b.height) return undefined;
  let changed = 0;
  for (let i = 0, j = 0; i < a.data.length && j < b.data.length; i += a.channels, j += b.channels) {
    if (Math.abs(a.data[i]! - b.data[j]!) > PIXEL_DELTA || Math.abs(a.data[i + 1]! - b.data[j + 1]!) > PIXEL_DELTA || Math.abs(a.data[i + 2]! - b.data[j + 2]!) > PIXEL_DELTA) changed++;
  }
  return changed;
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
