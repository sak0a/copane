// Key names and chords ("Enter", "Control+Shift+K", "ControlOrMeta+a") to CDP key events. The names
// follow the DOM `KeyboardEvent.key` values, which is also what Playwright accepts.

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Text the key inserts, if any. */
  text?: string;
  /** `key` and `text` while Shift is held. */
  shiftKey?: string;
  location?: number;
}

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED: KeyDefinition[] = [
  { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  { key: 'Tab', code: 'Tab', keyCode: 9 },
  { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  { key: 'Delete', code: 'Delete', keyCode: 46 },
  { key: 'Escape', code: 'Escape', keyCode: 27 },
  { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  { key: 'Home', code: 'Home', keyCode: 36 },
  { key: 'End', code: 'End', keyCode: 35 },
  { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  { key: 'Insert', code: 'Insert', keyCode: 45 },
  { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
  { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i })),
];

const PUNCTUATION: Array<[string, string, string, number]> = [
  // [key, shifted key, code, keyCode]
  ['-', '_', 'Minus', 189],
  ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219],
  [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186],
  ["'", '"', 'Quote', 222],
  [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
];
const DIGIT_SHIFTED = ')!@#$%^&*(';

const ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  space: ' ',
  spacebar: ' ',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  super: 'Meta',
  option: 'Alt',
  opt: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  plus: '+',
};

const byKey = new Map<string, KeyDefinition>();
for (const d of NAMED) byKey.set(d.key, d);
for (let c = 0; c < 26; c++) {
  const lower = String.fromCharCode(97 + c);
  const upper = lower.toUpperCase();
  const code = `Key${upper}`;
  byKey.set(lower, { key: lower, code, keyCode: 65 + c, text: lower, shiftKey: upper });
  byKey.set(upper, { key: upper, code, keyCode: 65 + c, text: upper, shiftKey: upper });
}
for (let d = 0; d < 10; d++) {
  const key = String(d);
  const def: KeyDefinition = { key, code: `Digit${d}`, keyCode: 48 + d, text: key, shiftKey: DIGIT_SHIFTED[d] };
  byKey.set(key, def);
  byKey.set(DIGIT_SHIFTED[d]!, { key: DIGIT_SHIFTED[d]!, code: `Digit${d}`, keyCode: 48 + d, text: DIGIT_SHIFTED[d] });
}
for (const [key, shifted, code, keyCode] of PUNCTUATION) {
  byKey.set(key, { key, code, keyCode, text: key, shiftKey: shifted });
  byKey.set(shifted, { key: shifted, code, keyCode, text: shifted });
}

const lowerNamed = new Map<string, string>();
for (const d of NAMED) lowerNamed.set(d.key.toLowerCase(), d.key);

/** The definition for a key name, or for any single character (typed as text). */
export function keyDefinition(name: string): KeyDefinition | undefined {
  const direct = byKey.get(name);
  if (direct) return direct;
  if (name.length > 1) {
    const lower = name.toLowerCase();
    const canonical = ALIASES[lower] ?? lowerNamed.get(lower);
    if (canonical) return byKey.get(canonical);
    return undefined;
  }
  // Any other single character (é, ß, emoji): text only.
  return { key: name, code: '', keyCode: 0, text: name };
}

export interface Chord {
  modifiers: Modifier[];
  key: KeyDefinition;
}

/**
 * Parses "Enter", "a", "Control+Shift+K", "Meta++" (the + key), "ControlOrMeta+a". Throws an Error
 * with a readable message for unknown keys.
 */
export function parseChord(input: string, isMac: boolean): Chord {
  const value = input.trim() === '' && input.length > 0 ? ' ' : input.trim();
  if (!value) throw new Error('No key given.');
  let parts: string[];
  if (value === '+') parts = ['+'];
  else if (value.endsWith('++')) parts = [...value.slice(0, -2).split('+'), '+'];
  else parts = value.split('+');
  if (parts.some(p => p === '')) throw new Error(`"${input}" is not a valid key combination. Write chords like "Control+Shift+K".`);
  const keyName = parts.pop()!;
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const m = modifierName(part, isMac);
    if (!m) throw new Error(`"${part}" in "${input}" is not a modifier. Use Shift, Control, Alt, Meta or ControlOrMeta.`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  const asModifier = modifierName(keyName, isMac);
  const key = keyDefinition(asModifier ?? keyName);
  if (!key) throw new Error(`Unknown key "${keyName}". Use names like Enter, Tab, Escape, ArrowDown, PageDown, F5, or a single character.`);
  return { modifiers, key };
}

function modifierName(name: string, isMac: boolean): Modifier | undefined {
  const lower = name.toLowerCase();
  if (lower === 'controlormeta' || lower === 'ctrlorcmd' || lower === 'cmdorctrl' || lower === 'mod') return isMac ? 'Meta' : 'Control';
  const canonical = ALIASES[lower] ?? (name === 'Shift' || name === 'Control' || name === 'Alt' || name === 'Meta' ? name : undefined);
  return canonical === 'Shift' || canonical === 'Control' || canonical === 'Alt' || canonical === 'Meta' ? canonical : undefined;
}

export function modifierMask(modifiers: readonly Modifier[]): number {
  return modifiers.reduce((mask, m) => mask | MODIFIER_BITS[m], 0);
}

// macOS: editing shortcuts are performed by the app menu, not the renderer, so synthetic key events
// need the editing command attached to do anything.
const MAC_COMMANDS: Record<string, string> = {
  'Meta+a': 'selectAll',
  'Meta+c': 'copy',
  'Meta+x': 'cut',
  'Meta+v': 'paste',
  'Meta+z': 'undo',
  'Meta+Shift+z': 'redo',
  'Meta+ArrowLeft': 'moveToBeginningOfLine',
  'Meta+ArrowRight': 'moveToEndOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+Shift+ArrowLeft': 'moveToBeginningOfLineAndModifySelection',
  'Meta+Shift+ArrowRight': 'moveToEndOfLineAndModifySelection',
  'Meta+Shift+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Meta+Shift+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Delete': 'deleteWordForward',
  'Meta+Backspace': 'deleteToBeginningOfLine',
};

export interface KeyEventParams {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  commands?: string[];
  autoRepeat?: boolean;
}

/** The keyDown and keyUp events for one key while `modifiers` are held. */
export function keyEvents(def: KeyDefinition, modifiers: readonly Modifier[], isMac: boolean): [KeyEventParams, KeyEventParams] {
  const shift = modifiers.includes('Shift');
  const key = shift && def.shiftKey ? def.shiftKey : def.key;
  const onlyShift = modifiers.every(m => m === 'Shift');
  const text = onlyShift && def.text !== undefined ? (shift && def.shiftKey ? def.shiftKey : def.text) : undefined;
  const base = {
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers: modifierMask(modifiers),
    ...(def.location ? { location: def.location } : {}),
  };
  const down: KeyEventParams = { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) };
  if (isMac) {
    const order: Modifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
    const combo = [...order.filter(m => modifiers.includes(m)), def.key.length === 1 ? def.key.toLowerCase() : def.key].join('+');
    const command = MAC_COMMANDS[combo];
    if (command) down.commands = [command];
  }
  return [down, { ...base, type: 'keyUp' }];
}

/** Display form of a chord, e.g. "Control+Shift+K". */
export function chordLabel(chord: Chord): string {
  const key = chord.key.key === ' ' ? 'Space' : chord.key.key;
  return [...chord.modifiers, key].join('+');
}
