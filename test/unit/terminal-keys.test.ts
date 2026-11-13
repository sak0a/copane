import { describe, expect, it } from 'vitest';
import { describeInput, encodeKeys, KeyError } from '../../src/extension/terminal/keys';

describe('encodeKeys', () => {
  it('encodes named keys, control keys and single characters', () => {
    expect(encodeKeys(['Enter'])).toBe('\r');
    expect(encodeKeys(['Ctrl+C'])).toBe('\x03');
    expect(encodeKeys(['ctrl-d'])).toBe('\x04');
    expect(encodeKeys(['^Z'])).toBe('\x1a');
    expect(encodeKeys(['Ctrl+\\'])).toBe('\x1c');
    expect(encodeKeys(['y', 'Enter'])).toBe('y\r');
    expect(encodeKeys(['Escape', 'Tab', 'Shift+Tab', 'Backspace'])).toBe('\x1b\t\x1b[Z\x7f');
    expect(encodeKeys(['F1', 'F5', 'PageDown'])).toBe('\x1bOP\x1b[15~\x1b[6~');
    expect(encodeKeys(['Alt+b'])).toBe('\x1bb');
    expect(encodeKeys(['Space'])).toBe(' ');
  });

  it('sends arrows in the mode the program asked for', () => {
    expect(encodeKeys(['Up', 'Down'])).toBe('\x1b[A\x1b[B');
    expect(encodeKeys(['Up', 'Left'], { applicationCursor: true })).toBe('\x1bOA\x1bOD');
    expect(encodeKeys(['Ctrl+Right'])).toBe('\x1b[1;5C');
  });

  it('rejects unknown keys with the list of valid ones', () => {
    expect(() => encodeKeys(['Hyper+Q'])).toThrow(KeyError);
    expect(() => encodeKeys(['Enterr'])).toThrow(/Unknown key "Enterr"/);
  });

  it('describes input without echoing long text', () => {
    expect(describeInput('y', ['Enter'])).toBe('"y" + Enter');
    expect(describeInput('x'.repeat(100), undefined)).toBe('100 characters of text');
  });
});
