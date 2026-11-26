import { describe, expect, it } from 'vitest';
import { assessActivity, looksLikeShellPrompt, stoppedForInput, type ActivityInput } from '../../src/extension/terminal/activity';

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

  it('has a brief form for repeated polls, except at a prompt (which always says what to do)', () => {
    const full = assessActivity({ ...base, alternate: true });
    expect(full.summary).toMatch(/terminal_send/);
    expect(full.brief).toBe('A full-screen program owns the terminal (quiet for 5.0 s).');
    expect(assessActivity(base).brief).toBe('No output for 5.0 s, no prompt.');
    const prompt = assessActivity({ ...base, beforeCursor: 'Password: ', tail: ['Password:'] });
    expect(prompt.brief).toBe(prompt.summary);
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

describe('stoppedForInput (a wait for the command ends early)', () => {
  const quiet = (ms: number, beforeCursor: string, tail: string[] = []): ActivityInput => ({ ...base, quietMs: ms, beforeCursor, tail });

  it('ends at a clear request for a key, a choice, a login or a secret, once output is quiet', () => {
    for (const line of ['Continue? [y/n] ', 'Overwrite (y/N) ', 'Password: ', "Enter passphrase for key '/home/u/.ssh/id': ", 'Username for https://github.com: ', 'Press Enter to continue', 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ']) {
      expect(stoppedForInput(quiet(1300, line)), line).toBe(true);
      expect(stoppedForInput(quiet(600, line)), `${line} (output just arrived)`).toBe(false);
    }
    expect(stoppedForInput(quiet(1300, '', ['? Pick a template (Use arrow keys)', '❯ react', '  vue']))).toBe(true);
  });

  it('gives a line that only reads like a question more time', () => {
    for (const line of ['What is your name? ', 'Project name: ', 'Ok to proceed? (y) ', 'Package name: (my-app) ']) {
      expect(stoppedForInput(quiet(1300, line)), line).toBe(false);
      expect(stoppedForInput(quiet(3100, line)), line).toBe(true);
    }
  });

  it('does not end for a command that is merely slow or silent', () => {
    expect(stoppedForInput(quiet(60_000, '', ['Compiling 3 files']))).toBe(false);
    // Progress left on the cursor line, a prompt character, a secret word in ordinary output.
    for (const line of ['[=====>      ] 45%', 'Downloading (3/10)', '>>> ', 'sqlite> ', 'Fetching token', 'user@host ws % ', 'Waiting for the deployment to continue', 'Select a region in the console']) {
      expect(stoppedForInput(quiet(60_000, line)), line).toBe(false);
    }
    expect(stoppedForInput(quiet(60_000, '', ['Refreshing the access token', 'run "npm fund" to continue', 'Select a region in the console']))).toBe(false);
    // A question that was answered stays on screen while the command works on in silence.
    expect(stoppedForInput(quiet(60_000, '', ['Overwrite? (y/N) y', 'working']))).toBe(false);
    expect(stoppedForInput(quiet(60_000, '', ['Press Enter to continue', 'Installing dependencies']))).toBe(false);
    expect(stoppedForInput(quiet(1300, '', ['Installing dependencies', 'Press any key to continue . . .']))).toBe(true);
    // The cursor sits inside a line: something is being redrawn, not asked.
    expect(stoppedForInput({ ...quiet(60_000, 'Continue? [y/n] '), afterCursor: 'x' })).toBe(false);
  });

  it('does not end for what an earlier command left on screen, or when nothing runs', () => {
    expect(stoppedForInput({ ...quiet(60_000, 'Continue? [y/n] '), outputSinceStart: false })).toBe(false);
    expect(stoppedForInput({ ...quiet(60_000, 'Continue? [y/n] '), running: false })).toBe(false);
  });

  it('ends for a full-screen program once its screen is still', () => {
    expect(stoppedForInput({ ...base, alternate: true, quietMs: 1300 })).toBe(false);
    expect(stoppedForInput({ ...base, alternate: true, quietMs: 2600 })).toBe(true);
  });

  it('never ends where assessActivity would not call it waiting', () => {
    for (const input of [quiet(3100, 'Project name: '), quiet(1300, 'Password: '), quiet(1300, '', ['(Use arrow keys)']), { ...base, alternate: true, quietMs: 2600 }]) {
      expect(stoppedForInput(input)).toBe(true);
      expect(['waiting-for-input', 'full-screen']).toContain(assessActivity(input).kind);
    }
  });
});
