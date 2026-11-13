import { describe, expect, it } from 'vitest';
import { chordLabel, keyDefinition, keyEvents, modifierMask, parseChord } from '../../src/extension/browser/page/keys';

describe('parseChord', () => {
  it('parses single keys, chords and aliases', () => {
    expect(parseChord('Enter', false)).toMatchObject({ modifiers: [], key: { key: 'Enter', keyCode: 13 } });
    expect(parseChord('enter', false).key.key).toBe('Enter');
    expect(parseChord('Esc', false).key.key).toBe('Escape');
    const c = parseChord('Control+Shift+K', false);
    expect(c.modifiers).toEqual(['Control', 'Shift']);
    expect(c.key.code).toBe('KeyK');
    expect(parseChord('ctrl+alt+Delete', false).modifiers).toEqual(['Control', 'Alt']);
    expect(parseChord('Cmd+a', true).modifiers).toEqual(['Meta']);
  });

  it('handles the plus key and space', () => {
    expect(parseChord('+', false).key.key).toBe('+');
    const c = parseChord('Shift++', false);
    expect(c.modifiers).toEqual(['Shift']);
    expect(c.key.key).toBe('+');
    expect(parseChord(' ', false).key.code).toBe('Space');
    expect(parseChord('Space', false).key.key).toBe(' ');
  });

  it('maps ControlOrMeta per platform', () => {
    expect(parseChord('ControlOrMeta+a', true).modifiers).toEqual(['Meta']);
    expect(parseChord('ControlOrMeta+a', false).modifiers).toEqual(['Control']);
  });

  it('accepts a modifier alone and any single character', () => {
    expect(parseChord('Shift', false).key.key).toBe('Shift');
    expect(parseChord('é', false).key).toMatchObject({ key: 'é', text: 'é', keyCode: 0 });
  });

  it('rejects unknown keys and modifiers with a readable message', () => {
    expect(() => parseChord('Foo', false)).toThrow(/Unknown key "Foo"/);
    expect(() => parseChord('Hyper+a', false)).toThrow(/not a modifier/);
    expect(() => parseChord('a++b', false)).toThrow(/not a valid key combination/);
    expect(() => parseChord('', false)).toThrow(/No key/);
  });

  it('labels chords', () => {
    expect(chordLabel(parseChord('ctrl+shift+k', false))).toBe('Control+Shift+k');
    expect(chordLabel(parseChord('Space', false))).toBe('Space');
  });
});

describe('keyEvents', () => {
  it('inserts text for printable keys, shifted when Shift is held', () => {
    const [down, up] = keyEvents(keyDefinition('a')!, [], false);
    expect(down).toMatchObject({ type: 'keyDown', key: 'a', text: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    expect(up).toMatchObject({ type: 'keyUp', key: 'a' });
    expect(up.text).toBeUndefined();
    const [shifted] = keyEvents(keyDefinition('1')!, ['Shift'], false);
    expect(shifted).toMatchObject({ key: '!', text: '!', modifiers: 8 });
  });

  it('sends no text with Control, Alt or Meta, and raw key down for non-printables', () => {
    const [ctrl] = keyEvents(keyDefinition('a')!, ['Control'], false);
    expect(ctrl.type).toBe('rawKeyDown');
    expect(ctrl.text).toBeUndefined();
    expect(ctrl.modifiers).toBe(2);
    expect(keyEvents(keyDefinition('ArrowDown')!, [], false)[0].type).toBe('rawKeyDown');
    expect(keyEvents(keyDefinition('Enter')!, [], false)[0]).toMatchObject({ type: 'keyDown', text: '\r' });
  });

  it('attaches macOS editing commands', () => {
    expect(keyEvents(keyDefinition('a')!, ['Meta'], true)[0].commands).toEqual(['selectAll']);
    expect(keyEvents(keyDefinition('z')!, ['Meta', 'Shift'], true)[0].commands).toEqual(['redo']);
    expect(keyEvents(keyDefinition('a')!, ['Meta'], false)[0].commands).toBeUndefined();
  });

  it('computes modifier masks', () => {
    expect(modifierMask(['Alt', 'Control', 'Meta', 'Shift'])).toBe(15);
  });
});
