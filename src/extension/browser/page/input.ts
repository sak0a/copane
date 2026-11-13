// Real input through CDP: mouse events at viewport coordinates and key events, the same path a
// user's mouse and keyboard take, so pages see trusted events.
import { keepPageActive, type PageCall } from './call';
import { keyDefinition, keyEvents, modifierMask, type Chord, type Modifier } from './keys';

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/** Input only arrives in a page that behaves as if it were in front; see keepPageActive. */
export async function prepareInput(call: PageCall): Promise<void> {
  await keepPageActive(call);
}

async function modifiersDown(call: PageCall, modifiers: readonly Modifier[]): Promise<void> {
  const held: Modifier[] = [];
  for (const m of modifiers) {
    held.push(m);
    await call.send('Input.dispatchKeyEvent', { ...keyEvents(keyDefinition(m)!, held, false)[0] });
  }
}

async function modifiersUp(call: PageCall, modifiers: readonly Modifier[]): Promise<void> {
  const held = [...modifiers];
  for (const m of [...modifiers].reverse()) {
    held.splice(held.indexOf(m), 1);
    await call.send('Input.dispatchKeyEvent', { ...keyEvents(keyDefinition(m)!, held, false)[1] });
  }
}

export async function mouseMove(call: PageCall, x: number, y: number, modifiers: readonly Modifier[] = [], buttons = 0): Promise<void> {
  await call.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: modifierMask(modifiers), buttons, button: buttons ? 'left' : 'none' });
}

export async function click(call: PageCall, x: number, y: number, options: { button?: MouseButton; clickCount?: number; modifiers?: Modifier[] } = {}): Promise<void> {
  const button = options.button ?? 'left';
  const modifiers = options.modifiers ?? [];
  const mask = modifierMask(modifiers);
  await prepareInput(call);
  await modifiersDown(call, modifiers);
  try {
    await mouseMove(call, x, y, modifiers);
    for (let i = 1; i <= (options.clickCount ?? 1); i++) {
      await call.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_MASK[button], clickCount: i, modifiers: mask });
      await call.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, modifiers: mask });
    }
  } finally {
    if (modifiers.length && !call.state.dialog) await modifiersUp(call, modifiers);
  }
}

export async function wheel(call: PageCall, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await prepareInput(call);
  await call.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: 0 }, { timeoutMs: 3000 });
}

export async function pressChord(call: PageCall, chord: Chord): Promise<void> {
  await prepareInput(call);
  await modifiersDown(call, chord.modifiers);
  try {
    const [down, up] = keyEvents(chord.key, chord.modifiers, call.state.isMac);
    await call.send('Input.dispatchKeyEvent', { ...down });
    await call.send('Input.dispatchKeyEvent', { ...up });
  } finally {
    if (chord.modifiers.length && !call.state.dialog) await modifiersUp(call, chord.modifiers);
  }
}

/** Types text into the focused element: in one go (like a paste or IME commit), or key by key. */
export async function typeText(call: PageCall, text: string, slowly: boolean): Promise<void> {
  await prepareInput(call);
  if (!slowly) {
    await call.send('Input.insertText', { text });
    return;
  }
  for (const ch of text) {
    const def = keyDefinition(ch === '\n' ? 'Enter' : ch)!;
    const [down, up] = keyEvents(def, [], call.state.isMac);
    await call.send('Input.dispatchKeyEvent', { ...down });
    await call.send('Input.dispatchKeyEvent', { ...up });
  }
}
