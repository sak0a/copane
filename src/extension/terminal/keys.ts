// Key names an agent can send to a terminal ("Enter", "Ctrl+C", "Up" ...) and the bytes a real
// terminal sends for them. Same sequences on every OS: ConPTY on Windows understands them too.

const NAMED: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  del: '\x1b[3~',
  insert: '\x1b[2~',
  space: ' ',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

const ARROWS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** Control characters reachable as Ctrl+<char> besides letters. */
const CTRL_SYMBOLS: Record<string, string> = { '@': '\x00', space: '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f', '?': '\x7f' };

export const KEY_HELP =
  'Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, Ctrl+<letter> (Ctrl+C interrupts, Ctrl+D ends input), Alt+<key>, or a single character';

export class KeyError extends Error {}

/**
 * Translates key names into the bytes to send. `applicationCursor` is the terminal's DECCKM mode
 * (full-screen programs switch arrows to SS3 sequences). Throws KeyError for an unknown name.
 */
export function encodeKeys(keys: readonly string[], options: { applicationCursor?: boolean } = {}): string {
  return keys.map(k => encodeKey(k, options.applicationCursor ?? false)).join('');
}

function encodeKey(raw: string, applicationCursor: boolean): string {
  if (raw.length === 1) return raw;
  const name = raw.trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '+').replace(/^control\+/, 'ctrl+').replace(/^(option|meta)\+/, 'alt+');
  if (name in NAMED) return NAMED[name]!;
  if (name in ARROWS) return (applicationCursor ? '\x1bO' : '\x1b[') + ARROWS[name]!;
  // "ctrl+c", "ctrl+shift+c" (same byte), "^C"
  const ctrl = /^(?:ctrl\+(?:shift\+)?|\^)(.+)$/.exec(name);
  if (ctrl) {
    const target = ctrl[1]!;
    if (/^[a-z]$/.test(target)) return String.fromCharCode(target.charCodeAt(0) - 96);
    if (target in CTRL_SYMBOLS) return CTRL_SYMBOLS[target]!;
    if (target in ARROWS) return `\x1b[1;5${ARROWS[target]!}`;
  }
  const alt = /^alt\+(.+)$/.exec(name);
  if (alt) {
    const target = alt[1]!;
    if (target.length === 1) return `\x1b${raw.trim().slice(-1)}`;
    if (target in ARROWS) return `\x1b[1;3${ARROWS[target]!}`;
    if (target in NAMED) return `\x1b${NAMED[target]!}`;
  }
  throw new KeyError(`Unknown key "${raw}". Use one of: ${KEY_HELP}.`);
}

/** Human-readable rendering of what was sent, for tool results ("y", Enter). Never echoes long text. */
export function describeInput(text: string | undefined, keys: readonly string[] | undefined): string {
  const parts: string[] = [];
  if (text) parts.push(text.length > 60 ? `${text.length} characters of text` : JSON.stringify(text));
  if (keys?.length) parts.push(keys.join(', '));
  return parts.join(' + ') || 'nothing';
}
