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
  if (!input.running) return { kind: 'idle', summary: 'Nothing is running; the shell is at its prompt.', secret: false };
  const quietS = (input.quietMs / 1000).toFixed(1);
  const recent = input.tail.slice(-4).join('\n');
  const secret = SECRET_RE.test(input.beforeCursor) || SECRET_RE.test(input.tail.slice(-2).join('\n'));
  if (input.alternate) {
    return {
      kind: 'full-screen',
      summary: `A full-screen program owns the terminal (quiet for ${quietS} s). Read it with terminal_read { what: "screen" }, drive it with terminal_send keys (q quits most pagers), or interrupt it.`,
      secret,
    };
  }
  if (input.quietMs < QUIET_MS) {
    const summary = input.outputSinceStart === false ? 'It started moments ago and has printed nothing yet.' : 'Output is still arriving: the command is working.';
    return { kind: 'working', summary, secret: false };
  }
  const line = input.beforeCursor.trimEnd();
  const promptLike = line.trim() !== '' && input.afterCursor === '' && (QUESTION_RE.test(line) || CHOICE_RE.test(line) || LOGIN_RE.test(line) || secret);
  const menuLike = CHOICE_RE.test(recent);
  if (promptLike || menuLike) {
    const shown = (promptLike ? line.trim() : input.tail[input.tail.length - 1]?.trim() ?? '').slice(-120);
    const what = secret
      ? 'It appears to ask for a secret: call terminal_request_user_input so the user types it; never ask for it in chat.'
      : 'Answer with terminal_send (e.g. text plus keys ["Enter"]), or hand over with terminal_request_user_input if the user should decide.';
    return { kind: 'waiting-for-input', summary: `Probably waiting for input: no output for ${quietS} s and the last line is a prompt ("${shown}"). ${what}`, secret };
  }
  return {
    kind: 'silent',
    summary: `No output for ${quietS} s and nothing looks like a prompt: probably still working (or waiting without a prompt).`,
    secret,
  };
}

const SHELL_PROMPT_RE = /(^PS [^>]*>|[$#%>❯»➜λ])\s?$/;

/** Without shell integration: does the cursor line look like a shell prompt waiting for a command? */
export function looksLikeShellPrompt(beforeCursor: string, afterCursor: string): boolean {
  return afterCursor === '' && beforeCursor.trim() !== '' && SHELL_PROMPT_RE.test(beforeCursor.trimEnd() + (beforeCursor.endsWith(' ') ? ' ' : ''));
}
