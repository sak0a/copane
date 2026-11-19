// Console messages, uncaught errors and browser log entries of one tab, recorded from CDP events into
// a bounded buffer, and their formatting for the agent. Pure: fed with CDP event params.
import { clip, RingBuffer } from './ringBuffer';

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'log' | 'debug';

export interface ConsoleEntry {
  seq: number;
  time: number;
  level: ConsoleLevel;
  /** console.* call, uncaught exception, or a message from the browser itself (network, CSP, ...). */
  source: 'console' | 'exception' | 'browser';
  text: string;
  location: string | undefined;
  /** How many times this exact message repeated in a row. */
  count: number;
  /** Position (as `seq`) of its latest repeat, when it repeated: the entry itself keeps its first `seq`. */
  lastSeq?: number;
}

const MAX_TEXT = 2000;
const LEVEL_RANK: Record<ConsoleLevel, number> = { error: 4, warning: 3, info: 2, log: 2, debug: 1 };

export function levelAtLeast(level: ConsoleLevel, min: ConsoleLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/** Minimal shape of a CDP `Runtime.RemoteObject`. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ObjectPreview;
}
interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: Array<{ name: string; type: string; value?: string; subtype?: string }>;
  entries?: Array<{ key?: ObjectPreview; value: ObjectPreview }>;
}

/** One console argument as DevTools would print it, compactly. */
export function formatRemoteObject(o: RemoteObject): string {
  if (o.type === 'string') return String(o.value);
  if (o.type === 'undefined') return 'undefined';
  if (o.unserializableValue !== undefined) return o.unserializableValue;
  if (o.type === 'number' || o.type === 'boolean') return String(o.value);
  if (o.type === 'bigint') return `${o.description ?? o.value}n`;
  if (o.type === 'symbol' || o.type === 'function') return o.description?.split('\n')[0] ?? o.type;
  if (o.subtype === 'null') return 'null';
  if (o.subtype === 'error') return o.description ?? 'Error';
  if (o.subtype === 'node') return o.description ?? 'Node';
  if (o.preview) return formatPreview(o.preview);
  if ('value' in o && o.value !== undefined) {
    try {
      return JSON.stringify(o.value);
    } catch {
      // fall through
    }
  }
  return o.description ?? o.className ?? o.type;
}

function formatPreview(p: ObjectPreview): string {
  const more = p.overflow ? ', …' : '';
  const prop = (x: { name: string; type: string; value?: string; subtype?: string }) =>
    x.type === 'string' ? JSON.stringify(x.value ?? '') : x.type === 'object' && x.subtype !== 'null' ? (x.value || 'Object') : (x.value ?? x.type);
  if (p.subtype === 'array' || p.subtype === 'typedarray') {
    return `[${p.properties.map(prop).join(', ')}${more}]`;
  }
  if (p.entries && (p.subtype === 'map' || p.subtype === 'set')) {
    const entries = p.entries.map(e => (e.key ? `${formatPreview(e.key)} => ${formatPreview(e.value)}` : formatPreview(e.value)));
    return `${p.description ?? p.subtype}{${entries.join(', ')}${more}}`;
  }
  if (p.type !== 'object') return p.description ?? p.type;
  const prefix = p.description && p.description !== 'Object' ? `${p.description} ` : '';
  return `${prefix}{${p.properties.map(x => `${x.name}: ${prop(x)}`).join(', ')}${more}}`;
}

/** Applies printf-style substitutions (%s %d %i %f %o %O %c) of the first argument, like DevTools. */
export function formatConsoleArgs(args: RemoteObject[]): string {
  if (args.length === 0) return '';
  const [first, ...rest] = args;
  if (first!.type !== 'string' || !/%[sdifoOc]/.test(String(first!.value))) return args.map(formatRemoteObject).join(' ');
  const queue = [...rest];
  const head = String(first!.value).replace(/%([sdifoOc%])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    const arg = queue.shift();
    if (!arg) return match;
    if (spec === 'c') return '';
    if (spec === 'd' || spec === 'i') return arg.type === 'number' ? String(Math.trunc(Number(arg.value))) : 'NaN';
    if (spec === 'f') return arg.type === 'number' ? String(arg.value) : 'NaN';
    return formatRemoteObject(arg);
  });
  return [head, ...queue.map(formatRemoteObject)].join(' ');
}

interface StackTrace {
  callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }>;
}

function location(url: string | undefined, line: number | undefined, column: number | undefined): string | undefined {
  if (!url) return undefined;
  return `${url}${line !== undefined ? `:${line + 1}` : ''}${column !== undefined ? `:${column + 1}` : ''}`;
}

function frameLocation(stack: StackTrace | undefined): string | undefined {
  const top = stack?.callFrames?.find(f => f.url);
  return top ? location(top.url, top.lineNumber, top.columnNumber) : undefined;
}

export class ConsoleLog {
  readonly entries: RingBuffer<ConsoleEntry>;

  constructor(
    capacity: number,
    private readonly nextSeq: () => number,
  ) {
    this.entries = new RingBuffer(capacity);
  }

  /** `Runtime.consoleAPICalled` */
  onConsoleApi(p: { type: string; args: RemoteObject[]; timestamp?: number; stackTrace?: StackTrace }): ConsoleEntry | undefined {
    const level: ConsoleLevel | undefined =
      p.type === 'error' || p.type === 'assert' ? 'error'
      : p.type === 'warning' ? 'warning'
      : p.type === 'info' ? 'info'
      : p.type === 'debug' ? 'debug'
      : p.type === 'endGroup' || p.type === 'clear' || p.type === 'profile' || p.type === 'profileEnd' ? undefined
      : 'log';
    if (!level) return undefined;
    let text = formatConsoleArgs(p.args ?? []);
    if (p.type === 'assert') text = `Assertion failed${text ? `: ${text}` : ''}`;
    if (p.type === 'trace') text = `console.trace${text ? `: ${text}` : ''}`;
    return this.add(level, 'console', text, frameLocation(p.stackTrace));
  }

  /** `Runtime.exceptionThrown` */
  onException(p: { exceptionDetails: { text?: string; exception?: RemoteObject; url?: string; lineNumber?: number; columnNumber?: number; stackTrace?: StackTrace } }): ConsoleEntry {
    const d = p.exceptionDetails;
    const description = d.exception?.description ?? (d.exception ? formatRemoteObject(d.exception) : undefined);
    // `description` of an Error holds its stack; keep the message and the first few frames.
    const text = description ? description.split('\n').slice(0, 6).join('\n') : (d.text ?? 'Uncaught exception');
    const prefix = text.startsWith('Uncaught') ? '' : 'Uncaught ';
    return this.add('error', 'exception', `${prefix}${text}`, location(d.url, d.lineNumber, d.columnNumber) ?? frameLocation(d.stackTrace));
  }

  /** `Log.entryAdded` */
  onLogEntry(p: { entry: { source: string; level: string; text: string; url?: string; lineNumber?: number } }): ConsoleEntry | undefined {
    const e = p.entry;
    const level: ConsoleLevel | undefined = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : e.level === 'info' ? 'info' : undefined;
    if (!level) return undefined;
    return this.add(level, 'browser', e.text, location(e.url, e.lineNumber, undefined));
  }

  /**
   * Entries logged after `seq`, like `entries.after`, plus the entry before them when the same message
   * was logged again after `seq` (repeats are folded into one entry, which keeps its first `seq`). That
   * one comes as a copy placed at its latest repeat.
   */
  since(seq: number): ConsoleEntry[] {
    const all = this.entries.all();
    const first = all.findIndex(e => e.seq > seq);
    const later = first < 0 ? [] : all.slice(first);
    const before = all[(first < 0 ? all.length : first) - 1];
    return before?.lastSeq !== undefined && before.lastSeq > seq ? [{ ...before, seq: before.lastSeq }, ...later] : later;
  }

  private add(level: ConsoleLevel, source: ConsoleEntry['source'], text: string, loc: string | undefined): ConsoleEntry {
    const clipped = clip(text, MAX_TEXT);
    const last = this.entries.last();
    if (last && last.text === clipped && last.level === level && last.source === source && last.location === loc) {
      last.count++;
      last.time = Date.now();
      last.lastSeq = this.nextSeq();
      return last;
    }
    const entry: ConsoleEntry = { seq: this.nextSeq(), time: Date.now(), level, source, text: clipped, location: loc, count: 1 };
    this.entries.push(entry);
    return entry;
  }
}

/** One entry as one (or a few) lines for the agent. */
export function formatConsoleEntry(e: ConsoleEntry, { withLocation = true } = {}): string {
  const tag = e.source === 'exception' ? 'exception' : e.source === 'browser' ? `browser ${e.level}` : e.level;
  const repeat = e.count > 1 ? ` (×${e.count})` : '';
  const loc = withLocation && e.location ? `  (${shortLocation(e.location)})` : '';
  return `[${tag}] ${e.text}${repeat}${loc}`;
}

/** "http://localhost:3000/src/app.js:12:5" → "/src/app.js:12:5" when it is on the page's origin. */
export function shortLocation(loc: string, pageUrl?: string): string {
  try {
    const u = new URL(loc.replace(/(:\d+)+$/, ''));
    const suffix = loc.slice(loc.replace(/(:\d+)+$/, '').length);
    if (pageUrl && new URL(pageUrl).origin === u.origin) return `${u.pathname}${suffix}`;
    return `${u.host}${u.pathname}${suffix}`;
  } catch {
    return loc;
  }
}
