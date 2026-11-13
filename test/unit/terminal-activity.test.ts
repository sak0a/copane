import { describe, expect, it } from 'vitest';
import { assessActivity, looksLikeShellPrompt, type ActivityInput } from '../../src/extension/terminal/activity';

const base: ActivityInput = { running: true, quietMs: 5000, beforeCursor: '', afterCursor: '', tail: [], alternate: false };

describe('assessActivity', () => {
  it('is idle when nothing runs', () => {
    expect(assessActivity({ ...base, running: false }).kind).toBe('idle');
  });

  it('is working while output keeps arriving', () => {
    expect(assessActivity({ ...base, quietMs: 200, beforeCursor: 'Password: ' }).kind).toBe('working');
  });

  it('does not claim output is arriving when nothing was printed yet', () => {
    expect(assessActivity({ ...base, quietMs: 300, outputSinceStart: false }).summary).toMatch(/printed nothing yet/);
  });

  it('recognises a password prompt as waiting for a secret', () => {
    const a = assessActivity({ ...base, beforeCursor: 'Password: ', tail: ['Password:'] });
    expect(a.kind).toBe('waiting-for-input');
    expect(a.secret).toBe(true);
    expect(a.summary).toMatch(/terminal_request_user_input/);
  });

  it('recognises yes/no questions and menus', () => {
    expect(assessActivity({ ...base, beforeCursor: 'Continue? [Y/n] ' }).kind).toBe('waiting-for-input');
    const menu = assessActivity({ ...base, beforeCursor: '', tail: ['? Pick a template (Use arrow keys)', '❯ react', '  vue'] });
    expect(menu.kind).toBe('waiting-for-input');
    expect(menu.secret).toBe(false);
  });

  it('calls quiet output without a prompt silent', () => {
    expect(assessActivity({ ...base, beforeCursor: '', tail: ['Compiling 3 files'] }).kind).toBe('silent');
  });

  it('reports full-screen programs', () => {
    expect(assessActivity({ ...base, alternate: true }).kind).toBe('full-screen');
  });
});

describe('looksLikeShellPrompt', () => {
  it('matches common prompts', () => {
    for (const p of ['user@host:~/x$ ', 'root@box:/# ', 'host% ', 'PS C:\\Users\\me> ', 'C:\\Users\\me>', '❯ ']) expect(looksLikeShellPrompt(p, '')).toBe(true);
  });
  it('does not match ordinary output or a cursor inside a line', () => {
    expect(looksLikeShellPrompt('Compiling...', '')).toBe(false);
    expect(looksLikeShellPrompt('$ ', 'echo hi')).toBe(false);
    expect(looksLikeShellPrompt('', '')).toBe(false);
  });
});
