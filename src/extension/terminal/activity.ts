// Guessing what a running command is doing from what is on screen: still producing output, waiting
// at a prompt for input, showing a full-screen program, or silent. Terminals do not say whether a
// program is reading input, so this is a heuristic, and results say so.

export type ActivityKind =
  /** Nothing is running. */
  | 'idle'
  /** Output arrived recently. */
  | 'working'
  /** The last line looks like a prompt and the output has stopped. */
  | 'waiting-for-input'
  /** A full-screen program (editor, pager, top ...) owns the screen. */
  | 'full-screen'
  /** No output for a while, nothing looks like a prompt. Could be busy or waiting silently. */
  | 'silent';

export interface ActivityInput {
  running: boolean;
  /** Milliseconds since the terminal last printed anything. */
  quietMs: number;
  /** Text on the cursor line before the cursor. */
  beforeCursor: string;
  /** Text on the cursor line after the cursor (non-empty when the cursor sits inside a line). */
  afterCursor: string;
  /** The last few non-empty lines of the screen, oldest first. */
  tail: readonly string[];
  alternate: boolean;
  /** False while the running command has not printed anything yet. Defaults to true. */
  outputSinceStart?: boolean;
}

export interface Activity {
  kind: ActivityKind;
  /** One sentence for the agent. */
  summary: string;
  /** The same, without the advice, for an agent that already read `summary` (repeated polls). */
  brief: string;
  /** The prompt seems to ask for a secret: hand over to the user instead of answering. */
  secret: boolean;
}

/** Output must have been quiet this long before a prompt counts as "waiting". */
export const QUIET_MS = 1200;

const SECRET_RE = /\b(pass(word|phrase|code)?|pin|otp|one[- ]time|2fa|mfa|two[- ]factor|verification code|auth(entication)? code|security code|token|secret|private key)\b/i;
const QUESTION_RE = /(\?|:|>|\]|\)|»|›|❯|\$|#|%)\s*$/;
const CHOICE_RE = /\((y\/n|yes\/no|y\/N|Y\/n)\)|\[(y\/n|Y\/n|y\/N|yes\/no)\]|use arrow keys|press (enter|return|any key)|to continue|select an? |choose an? |\(enter to (submit|confirm)\)/i;
const LOGIN_RE = /\b(user ?name|login|e-?mail|sign in|one-time code|device code|open .*https?:\/\/)\b/i;

export function assessActivity(input: ActivityInput): Activity {
  if (!input.running) {
    const summary = 'Nothing is running; the shell is at its prompt.';
    return { kind: 'idle', summary, brief: summary, secret: false };
  }
  const quietS = (input.quietMs / 1000).toFixed(1);
  const recent = input.tail.slice(-4).join('\n');
  const secret = SECRET_RE.test(input.beforeCursor) || SECRET_RE.test(input.tail.slice(-2).join('\n'));
  if (input.alternate) {
    return {
      kind: 'full-screen',
      summary: `A full-screen program owns the terminal (quiet for ${quietS} s). Drive it with terminal_send keys (q quits most pagers; the result shows the screen), or interrupt it.`,
      brief: `A full-screen program owns the terminal (quiet for ${quietS} s).`,
      secret,
    };
  }
  if (input.quietMs < QUIET_MS) {
    const summary = input.outputSinceStart === false ? 'It started moments ago and has printed nothing yet.' : 'Output is still arriving: the command is working.';
    return { kind: 'working', summary, brief: summary, secret: false };
  }
  const line = input.beforeCursor.trimEnd();
  const promptLike = line.trim() !== '' && input.afterCursor === '' && (QUESTION_RE.test(line) || CHOICE_RE.test(line) || LOGIN_RE.test(line) || secret);
  const menuLike = CHOICE_RE.test(recent);
  if (promptLike || menuLike) {
    const shown = (promptLike ? line.trim() : input.tail[input.tail.length - 1]?.trim() ?? '').slice(-120);
    const what = secret
      ? 'It appears to ask for a secret: call terminal_request_user_input so the user types it; never ask for it in chat.'
      : 'Answer with terminal_send (e.g. text plus keys ["Enter"]), or hand over with terminal_request_user_input if the user should decide.';
    // The prompt (and what to do about a secret) can differ each time: always said in full.
    const summary = `Probably waiting for input: no output for ${quietS} s and the last line is a prompt ("${shown}"). ${what}`;
    return { kind: 'waiting-for-input', summary, brief: summary, secret };
  }
  return {
    kind: 'silent',
    summary: `No output for ${quietS} s and nothing looks like a prompt: probably still working (or waiting without a prompt).`,
    brief: `No output for ${quietS} s, no prompt.`,
    secret,
  };
}

/** In a full-screen program (a pager, an editor), a wait ends once the screen has been still this long. */
export const FULL_SCREEN_STILL_MS = 2500;
/** At a line that only looks like a question, a wait ends once output has been quiet this long. */
export const QUESTION_STILL_MS = 3000;

/** Says in so many words that a key or an answer is expected. */
const ASKS_FOR_KEY_RE = /\((y\/n|yes\/no|y\/N|Y\/n)\)|\[(y\/n|Y\/n|y\/N|yes\/no)\]|use arrow keys|press (enter|return|any key)|\(enter to (submit|confirm)\)/i;
/** Stays above the choices for as long as a menu is open (the libraries that draw one erase it on an answer). */
const OPEN_MENU_RE = /use arrow keys|\(enter to (submit|confirm)\)/i;
/** A request for a key that ends the output so far, the cursor waiting on the line below. */
const KEY_REQUEST_LAST_RE = /press (enter|return|any key)[^\n]{0,40}$/i;
/** A question or a label, with an optional hint after it: "Name:", "Proceed? (y)", "... (yes/no/[fingerprint])?". */
const QUESTION_LINE_RE = /[?:]\s*(\([^()]{1,30}\)|\[[^[\]]{1,30}\])?\s*:?\s*$/;

/**
 * Whether a wait for the running command should end now, because the command will not go on until
 * someone answers: it asks for a key, a choice, a login or a secret (after `QUIET_MS` of silence),
 * its last line reads like a question (after `QUESTION_STILL_MS`: a build can pause at such a line),
 * or a full-screen program holds a still screen. Stricter than `assessActivity`, which only words
 * a guess: ending a wait early for a command that was merely slow costs the agent another call.
 * `tail` must be the command's own output, so an earlier command's "press Enter" does not count.
 */
export function stoppedForInput(input: ActivityInput): boolean {
  if (!input.running) return false;
  if (input.alternate) return input.quietMs >= FULL_SCREEN_STILL_MS;
  // Nothing printed yet: what is on the cursor line is not this command's.
  if (input.outputSinceStart === false || input.quietMs < QUIET_MS) return false;
  const line = input.beforeCursor.trimEnd();
  const atLine = line.trim() !== '' && input.afterCursor === '';
  if (atLine && (ASKS_FOR_KEY_RE.test(line) || (QUESTION_RE.test(line) && (CHOICE_RE.test(line) || SECRET_RE.test(line) || LOGIN_RE.test(line))))) return true;
  // Above the cursor only what cannot be a question already answered: "Overwrite? (y/N) y" stays
  // on screen while the command works on.
  const tail = input.tail.slice(-4);
  if (OPEN_MENU_RE.test(tail.join('\n')) || KEY_REQUEST_LAST_RE.test(tail[tail.length - 1]?.trimEnd() ?? '')) return true;
  return atLine && QUESTION_LINE_RE.test(line) && input.quietMs >= QUESTION_STILL_MS;
}

const SHELL_PROMPT_RE = /(^PS [^>]*>|[$#%>❯»➜λ])\s?$/;

/** Without shell integration: does the cursor line look like a shell prompt waiting for a command? */
export function looksLikeShellPrompt(beforeCursor: string, afterCursor: string): boolean {
  return afterCursor === '' && beforeCursor.trim() !== '' && SHELL_PROMPT_RE.test(beforeCursor.trimEnd() + (beforeCursor.endsWith(' ') ? ' ' : ''));
}
