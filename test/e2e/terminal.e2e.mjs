// Integrated terminals, against a running dev host:
//
//   node scripts/dev-host.mjs --name terminal
//   node test/e2e/terminal.e2e.mjs --name terminal [--only <text>]
//
// Plays the user through `debug_vscode_command` (opening a terminal, typing with
// workbench.action.terminal.sendSequence) and `debug_answer_prompts` (answering the extension's
// notifications). Assumes a POSIX shell with shell integration as the default profile (bash/zsh).
import { join } from 'node:path';
import { agent, assert, root, run, sleep, test as testCase, until } from './harness.mjs';

// The commands below (seq, sleep, quoting, /bin/sh) are POSIX; Windows' default terminal is PowerShell.
const notPosix = process.platform === 'win32' ? 'needs a POSIX shell (bash or zsh) as the default terminal; Windows uses PowerShell' : undefined;
const test = (name, fn) => testCase(name, fn, { skip: notPosix });

const fixture = name => join(root, 'test', 'fixtures', 'terminal', name);
const q = s => `'${s.replace(/'/g, `'\\''`)}'`;
const node = (name, ...args) => [process.execPath, fixture(name), ...args].map(q).join(' ');
const termId = text => /\b(term-\d+)\b/.exec(text)?.[1];

/** A connection that stands in for the user. */
let userAgent;
async function user() {
  userAgent ??= await agent({ session: 'term-e2e-user' });
  return userAgent;
}
async function answerPrompts(answers) {
  await (await user()).ok('debug_answer_prompts', { answers, clear: true });
}
async function shownPrompts() {
  return JSON.parse(await (await user()).ok('debug_answer_prompts', {})).shown;
}
/** Types into the active terminal, as the user at the keyboard. */
async function userTypes(text) {
  await (await user()).ok('debug_vscode_command', { command: 'workbench.action.terminal.sendSequence', args: [{ text }] });
}
async function list(a) {
  const text = await a.ok('terminal_list');
  return text.startsWith('No terminals') ? [] : JSON.parse(text);
}
/** A result without the notes about degraded capabilities at its end. */
const body = text => text.replace(/\nNote: .*$/s, '');
async function closeAll(a) {
  for (const t of await list(a)) if (t.owner === 'you') await a.call('terminal_close', { terminal: t.id });
}

test('runs commands and returns rendered output and exit codes', async () => {
  const a = await agent({ session: 'term-basic' });
  try {
    const first = await a.ok('terminal_run', { command: "echo hello; printf '\\033[31mred\\033[0m\\n'; false" });
    assert.match(first, /exited with code 1/);
    assert.match(first, /hello\nred/);
    assert.doesNotMatch(first, /\x1b/);
    const id = termId(first);
    assert.ok(id, first);
    const failing = await a.ok('terminal_run', { command: 'ls /definitely/not/here' });
    assert.match(failing, /exited with code [12]/);
    assert.match(failing, /No such file or directory/);
    assert.equal(termId(failing), id, 'the session keeps using its terminal');
    const [mine] = (await list(a)).filter(t => t.owner === 'you');
    assert.equal(mine.state, 'idle');
    assert.ok(mine.name.startsWith('Claude'), mine.name);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('interprets progress bars, colors and cursor movement', async () => {
  const a = await agent({ session: 'term-progress' });
  try {
    const out = await a.ok('terminal_run', { command: node('progress.mjs') });
    assert.match(out, /exited with code 0/);
    assert.match(out, /downloading \[##########\] 100%\ntask a: done\ntask b: done\ncomplete/);
    assert.doesNotMatch(out, /waiting|running|90%/);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

/** The cut-range marker of a head+tail result: [from, to, the call that reads them]. */
const cutRange = text => {
  const m = /\[… (\d+) lines? cut here \(lines (\d+)-(\d+) of (\d+)\)\. Read them with (terminal_read (\{.*\}))\.\]/.exec(text);
  return m && { count: Number(m[1]), from: Number(m[2]), to: Number(m[3]), total: Number(m[4]), call: m[5], args: JSON.parse(m[6]) };
};

test('cuts long output in the middle (start and end kept) and pages through the rest', async () => {
  const a = await agent({ session: 'term-long' });
  try {
    const out = await a.ok('terminal_run', { command: 'seq 1 3000', max_chars: 2000 });
    const cut = cutRange(out);
    assert.ok(cut, out.slice(0, 600));
    assert.equal(cut.total, 3000);
    assert.match(out, /exited with code 0[^\n]*\n1\n2\n3\n/);
    assert.ok(body(out).trimEnd().endsWith('3000'), out.slice(-200));
    assert.ok(out.length < 2600, `result is ${out.length} chars`);
    const page = await a.ok('terminal_read', { what: 'command', from_line: 1, max_chars: 1000 });
    assert.match(page, /^1\n2\n3\n/m);
    assert.match(page, /more lines\. Continue with terminal_read/);
    const huge = await a.ok('terminal_run', { command: 'seq 1 20000' });
    assert.match(huge, /scrolled out of the terminal history/);
    assert.ok(cutRange(huge), huge.slice(0, 600));
    assert.ok(body(huge).trimEnd().endsWith('20000'));
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('by default a long output keeps its first and last lines and names the call for the rest', async () => {
  const a = await agent({ session: 'term-headtail' });
  try {
    // 3500 lines: all of it stays in the terminal history (4000 lines), so line N is the number N.
    const out = await a.ok('terminal_run', { command: 'seq 1 3500' });
    assert.match(out, /exited with code 0/);
    assert.ok(out.length < 13_000, `result is ${out.length} chars`);
    const cut = cutRange(out);
    assert.ok(cut, out.slice(0, 800));
    assert.equal(cut.total, 3500);
    assert.equal(cut.count, cut.to - cut.from + 1);
    const shown = body(out).split('\n').filter(l => /^\d+$/.test(l)).map(Number);
    const expected = [...Array.from({ length: cut.from - 1 }, (_, i) => i + 1), ...Array.from({ length: 3500 - cut.to }, (_, i) => cut.to + 1 + i)];
    assert.deepEqual(shown, expected, 'lines 1..from-1 and to+1..3500, in order');
    // The suggested call returns the missing lines, from the first one; paging on reaches all of them.
    assert.equal(cut.args.from_line, cut.from);
    const got = [];
    for (let args = cut.args, i = 0; args && i < 20; i++) {
      const page = await a.ok('terminal_read', args);
      got.push(...body(page).split('\n').filter(l => /^\d+$/.test(l)).map(Number));
      const next = /Continue with terminal_read (\{.*\})\.\]/.exec(page);
      args = next && got.at(-1) < cut.to ? JSON.parse(next[1]) : undefined;
    }
    assert.equal(got[0], cut.from);
    assert.ok(got.at(-1) >= cut.to, `paged to ${got.at(-1)}`);
    assert.deepEqual(got, Array.from({ length: got.length }, (_, i) => cut.from + i), 'every line exactly once');
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('repeated polls of a running command do not repeat its name and hints', async () => {
  const a = await agent({ session: 'term-polls' });
  try {
    const started = await a.ok('terminal_run', { command: 'sleep 8; echo poll-done', timeout_seconds: 1 });
    assert.match(started, /`sleep 8; echo poll-done` is still running/);
    assert.match(started, /Next: terminal_wait \{"terminal":"term-\d+"\}/);
    const polls = [];
    for (let i = 0; i < 3; i++) polls.push(await a.ok('terminal_wait', { timeout_seconds: 1 }));
    for (const poll of polls) {
      assert.match(poll, /Still running after waiting/);
      assert.doesNotMatch(poll, /sleep 8/, poll);
      assert.match(poll, /still running the same command \(for /);
    }
    const done = await a.ok('terminal_wait', { timeout_seconds: 20 });
    assert.match(done, /`sleep 8; echo poll-done` exited with code 0/);
    assert.match(done, /poll-done/);
    // The full suggestions came once for this terminal; a second running command gets the short form.
    const again = await a.ok('terminal_run', { command: 'sleep 3', timeout_seconds: 1 });
    assert.match(again, /Next: terminal_wait, terminal_read or terminal_send \(keys \["Ctrl\+C"\] stops it\)\./);
    await a.ok('terminal_wait', { timeout_seconds: 10 });
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('a long-running server keeps running; wait for text, read, interrupt', async () => {
  const a = await agent({ session: 'term-server' });
  try {
    const started = await a.ok('terminal_run', { command: node('server.mjs'), timeout_seconds: 1 });
    assert.match(started, /is still running in term-\d+ after/);
    assert.match(started, /starting server/);
    const id = termId(started);
    const [info] = (await list(a)).filter(t => t.id === id);
    assert.equal(info.state, 'running');
    assert.match(info.command, /server\.mjs/);
    const ready = await a.ok('terminal_wait', { terminal: id, for_text: 'Listening on', timeout_seconds: 20 });
    assert.match(ready, /appeared/);
    const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(ready)?.[1];
    assert.ok(url, ready);
    // A second command goes to a free terminal instead of interleaving with the server.
    const other = await a.ok('terminal_run', { command: `curl -s ${url}/hello` });
    assert.match(other, /is busy .*so I opened a new terminal|is busy .*so this runs in/s);
    const busy = await a.call('terminal_run', { terminal: id, command: 'echo nope' });
    assert.ok(busy.isError);
    assert.match(busy.text, /is busy: .*server\.mjs/);
    const log = await a.ok('terminal_wait', { terminal: id, for_text: 'GET /hello', timeout_seconds: 10 });
    assert.match(log, /GET \/hello/);
    assert.doesNotMatch(log, /Listening on/, 'only output since the last look');
    const stopped = await a.ok('terminal_send', { terminal: id, keys: ['Ctrl+C'] });
    assert.match(stopped, /Interrupted\. .*exited with code 130/);
    assert.match(stopped, /shutting down/);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('Ctrl+C stops a command', async () => {
  const a = await agent({ session: 'term-ctrlc' });
  try {
    const out = await a.ok('terminal_run', { command: 'sleep 100', timeout_seconds: 1 });
    assert.match(out, /still running/);
    // Ctrl+C alone waits for the command to end and says so.
    const sent = await a.ok('terminal_send', { keys: ['Ctrl+C'] });
    assert.match(sent, /^Interrupted\. .*`sleep 100` exited with code 130/s);
    const idle = await a.ok('terminal_send', { keys: ['Ctrl+C'] });
    assert.match(idle, /^Pressed Ctrl\+C in term-\d+; no command was running\./);
    // With other keys it is plain input.
    await a.ok('terminal_run', { command: 'sleep 100', timeout_seconds: 1 });
    const mixed = await a.ok('terminal_send', { keys: ['Ctrl+C', 'Enter'] });
    assert.match(mixed, /^Sent Ctrl\+C, Enter to term-\d+\./);
    assert.doesNotMatch(mixed, /Interrupted/);
    await until(async () => /is idle at the prompt/.test(await a.ok('terminal_wait', { timeout_seconds: 2 })), 'the terminal to be idle');
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('an old tool name still works and names the new call (terminal_interrupt)', async () => {
  const a = await agent({ session: 'term-alias' });
  try {
    assert.ok(!(await a.tools()).some(t => t.name === 'terminal_interrupt'), 'old names are not listed');
    await a.ok('terminal_run', { command: 'sleep 100', timeout_seconds: 1 });
    const stopped = await a.ok('terminal_interrupt', {});
    assert.match(stopped, /^\(terminal_interrupt is now terminal_send \{"keys":\["Ctrl\+C"\]\}: call that from now on; the old name will be removed\.\)\nInterrupted\. .*`sleep 100` exited with code 130/s);
    const wrong = await a.call('terminal_interrupt', { text: 'y' });
    assert.ok(wrong.isError);
    assert.match(wrong.text, /terminal_interrupt has no argument "text"; nothing was done\./);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('an interactive multi-step prompt is detected and answered', async () => {
  const a = await agent({ session: 'term-prompt' });
  try {
    const out = await a.ok('terminal_run', { command: node('prompt.mjs'), timeout_seconds: 3 });
    assert.match(out, /still running/);
    assert.match(out, /Probably waiting for input.*What is your name\?/);
    const step = await a.ok('terminal_send', { text: 'Ada', keys: ['Enter'] });
    assert.match(step, /Create a project for Ada\? \[y\/N\]/);
    // The answer's output may come back from terminal_send already; the wait reports the end.
    const answered = await a.ok('terminal_send', { text: 'y', keys: ['Enter'] });
    const done = await a.ok('terminal_wait', { timeout_seconds: 10 });
    assert.match(done, /exited with code 0/);
    assert.match(answered + done, /Hello Ada, project created\./);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('a full-screen program shows its screen and takes keys', async () => {
  const a = await agent({ session: 'term-fullscreen' });
  try {
    const out = await a.ok('terminal_run', { command: node('fullscreen.mjs'), timeout_seconds: 2 });
    assert.match(out, /full-screen program/i);
    const screen = await a.ok('terminal_read', { what: 'screen' });
    assert.match(screen, /full-screen program/);
    assert.match(screen, /FULLSCREEN DEMO\n\n {2}item one\n {2}item two/);
    assert.match(screen, /-- press q to quit --/);
    const quit = await a.ok('terminal_send', { keys: ['q'] });
    const done = await a.ok('terminal_wait', { timeout_seconds: 10 });
    assert.match(done, /exited with code 0/);
    assert.match(quit + done, /left full screen/);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('while a full-screen program runs, results show its screen and never repeat earlier output', async () => {
  const a = await agent({ session: 'term-fullscreen-tokens' });
  try {
    const earlier = await a.ok('terminal_run', { command: 'for i in $(seq 1 40); do echo "earlier-output-$i"; done' });
    assert.match(earlier, /earlier-output-40/);
    const started = await a.ok('terminal_run', { command: node('fullscreen.mjs'), timeout_seconds: 2 });
    assert.match(started, /Screen of term-\d+ .*full-screen program/);
    assert.match(started, /FULLSCREEN DEMO/);
    assert.doesNotMatch(started, /earlier-output/);
    // A key the program ignores: the result is its screen, not an earlier command's output.
    const sent = await a.ok('terminal_send', { keys: ['x'], wait_seconds: 1 });
    assert.match(sent, /Screen of term-\d+ .*full-screen program/);
    assert.match(sent, /FULLSCREEN DEMO\n\n {2}item one\n {2}item two/);
    assert.doesNotMatch(sent, /earlier-output/);
    const read = await a.ok('terminal_read', {});
    assert.match(read, /FULLSCREEN DEMO/);
    assert.doesNotMatch(read, /earlier-output/);
    const waited = await a.ok('terminal_wait', { timeout_seconds: 1 });
    assert.match(waited, /Still running/);
    assert.doesNotMatch(waited, /earlier-output/);
    const found = await a.ok('terminal_wait', { for_text: 'press q to quit', timeout_seconds: 5 });
    assert.match(found, /appeared/);
    // After it quits, only what is new: the line it printed, once, and no earlier output or screen.
    const quit = await a.ok('terminal_send', { keys: ['q'] });
    const done = await a.ok('terminal_wait', { timeout_seconds: 10 });
    const after = quit + done;
    assert.match(done, /exited with code 0/);
    assert.equal(after.match(/left full screen/g)?.length, 1, after);
    assert.doesNotMatch(after, /earlier-output|FULLSCREEN DEMO/);
    const again = await a.ok('terminal_read', {});
    assert.match(again, /no new output/);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('hand-off: the user types a password the agent never sees', async () => {
  const a = await agent({ session: 'term-handoff' });
  try {
    await answerPrompts([]);
    const pending = a.ok('terminal_request_user_input', { message: 'Enter the test password.', command: node('secret.mjs'), timeout_seconds: 60 });
    // The request shows up for the UI, and as a notification naming the session.
    await until(async () => (await list(a)).some(t => t.state === 'waiting-for-user'), 'terminal waiting for the user');
    await until(async () => (await (await user()).ok('terminal_list')).includes('waiting-for-user'), 'listed as waiting');
    await sleep(800);
    await userTypes('hunter2-secret\r');
    const result = await pending;
    assert.match(result, /exited with code 0/);
    assert.match(result, /received 14 chars/);
    assert.doesNotMatch(result, /hunter2/);
    assert.ok((await list(a)).every(t => t.state !== 'waiting-for-user'));
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('hand-off: the user says done, or declines', async () => {
  const a = await agent({ session: 'term-handoff2' });
  try {
    await a.ok('terminal_run', { command: 'echo ready' });
    await answerPrompts(['Done']);
    const done = await a.ok('terminal_request_user_input', { message: 'Log in to the CLI.', timeout_seconds: 30 });
    assert.match(done, /The user said they are done/);
    const prompt = (await shownPrompts()).at(-1);
    assert.match(prompt.message, /^Claude \d+ needs you in the terminal ".*": Log in to the CLI\.$/);
    assert.deepEqual(prompt.choices, ['Show Terminal', 'Done', "Won't Do"]);
    await answerPrompts(["Won't Do"]);
    const declined = await a.ok('terminal_request_user_input', { message: 'Approve the deploy.', timeout_seconds: 30 });
    assert.match(declined, /declined/);
    await answerPrompts([]);
    const timedOut = await a.ok('terminal_request_user_input', { message: 'Nobody will answer this.', timeout_seconds: 10 });
    assert.match(timedOut, /No answer from the user within/);
  } finally {
    await answerPrompts([]);
    await closeAll(a);
    await a.close();
  }
});

test("two sessions get their own terminals and need consent for each other's", async () => {
  const a = await agent({ session: 'term-two-a' });
  const b = await agent({ session: 'term-two-b' });
  try {
    const ra = await a.ok('terminal_run', { command: 'echo from-a' });
    const rb = await b.ok('terminal_run', { command: 'echo from-b' });
    const ta = termId(ra);
    const tb = termId(rb);
    assert.notEqual(ta, tb);
    const seenByB = (await list(b)).find(t => t.id === ta);
    assert.equal(seenByB.access, 'asks the user first');
    assert.equal(seenByB.command, undefined);
    await answerPrompts(['Deny']);
    const denied = await b.call('terminal_read', { terminal: ta });
    assert.ok(denied.isError);
    assert.match(denied.text, /did not allow/);
    assert.match((await shownPrompts()).at(-1).message, /wants to read and type in the terminal ".*" of Claude \d+/);
    const again = await b.call('terminal_read', { terminal: ta });
    assert.match(again.text, /declined .* a moment ago/);
    const closeOther = await b.call('terminal_close', { terminal: ta });
    assert.ok(closeOther.isError);
  } finally {
    await answerPrompts([]);
    await closeAll(a);
    await closeAll(b);
    await a.close();
    await b.close();
  }
});

test("the user's own terminal needs permission", async () => {
  const a = await agent({ session: 'term-userterm' });
  const b = await agent({ session: 'term-userterm-b' });
  try {
    const before = new Set((await list(a)).map(t => t.id));
    await (await user()).ok('debug_vscode_command', { command: 'workbench.action.terminal.new' });
    const mine = await until(async () => (await list(a)).find(t => !before.has(t.id) && t.owner === 'user'), 'user terminal listed');
    assert.equal(mine.access, 'asks the user first');
    // Printed before any agent may use it: kept cheaply, and shown once the agent is allowed in.
    await sleep(1500);
    await userTypes('echo printed-before-access-$((6*7))\r');
    await sleep(1000);
    await answerPrompts(['Allow']);
    await until(async () => /printed-before-access-42/.test(await a.ok('terminal_read', { terminal: mine.id, what: 'screen' })), 'output from before access on the screen');
    const last = await a.ok('terminal_read', { terminal: mine.id, what: 'command' });
    assert.match(last, /printed-before-access-42/);
    const ran = await a.ok('terminal_run', { terminal: mine.id, command: 'echo in-user-terminal' });
    assert.match(ran, /in-user-terminal/);
    assert.match((await shownPrompts()).at(-1).message, /wants to read and type in your terminal/);
    const read = await a.ok('terminal_read', { terminal: mine.id, what: 'command' });
    assert.match(read, /in-user-terminal/);
    await answerPrompts(['Deny']);
    const denied = await b.call('terminal_read', { terminal: mine.id });
    assert.ok(denied.isError);
    const close = await a.call('terminal_close', { terminal: mine.id });
    assert.ok(close.isError);
    assert.match(close.text, /only the user closes it/);
    await (await user()).ok('debug_vscode_command', { command: 'workbench.action.terminal.kill' });
  } finally {
    await answerPrompts([]);
    await closeAll(a);
    await a.close();
    await b.close();
  }
});

test('a terminal closed mid-command ends the wait', async () => {
  const a = await agent({ session: 'term-closed' });
  try {
    const out = await a.ok('terminal_run', { command: 'echo before-close; sleep 60', timeout_seconds: 1 });
    const id = termId(out);
    const waiting = a.ok('terminal_wait', { terminal: id, timeout_seconds: 30 });
    await sleep(500);
    await a.ok('terminal_close', { terminal: id });
    const result = await waiting;
    assert.match(result, /was closed|has been closed/);
    const gone = await a.call('terminal_read', { terminal: id });
    assert.ok(gone.isError);
    assert.match(gone.text, /no open terminal/);
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('without shell integration, commands still run and the result says what is degraded', async () => {
  const a = await agent({ session: 'term-nosi' });
  try {
    const created = await a.ok('terminal_create', { name: 'plain sh', shell: '/bin/sh', env: { PS1: '$ ' } });
    assert.match(created, /No shell integration/);
    const out = await a.ok('terminal_run', { command: 'echo no-si-output; echo second-line', timeout_seconds: 15 });
    if (/terminalDataWriteEvent\) is not enabled/.test(created)) {
      // No output access at all: the command is typed, and the result says it cannot be observed.
      assert.match(out, /Its result cannot be observed here/);
    } else {
      assert.match(out, /exit code unknown/);
      assert.match(out, /no-si-output\nsecond-line/);
    }
  } finally {
    await closeAll(a);
    await a.close();
  }
});

test('fast output does not stall the extension host, and the end of it is kept', async () => {
  const a = await agent({ session: 'term-fast' });
  const b = await agent({ session: 'term-fast-b' });
  try {
    const running = a.ok('terminal_run', { command: 'yes copane-fast-output | head -n 3000000; echo fast-done', timeout_seconds: 120 });
    // Meanwhile another session's calls are answered promptly.
    await sleep(1500);
    let slowest = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      await b.ok('session_info');
      slowest = Math.max(slowest, Date.now() - t0);
      await sleep(300);
    }
    assert.ok(slowest < 1500, `session_info took ${slowest} ms while a terminal printed fast`);
    const out = await running;
    assert.match(out, /exited with code 0/);
    // The thousands of identical lines kept are collapsed into one with their count.
    assert.match(out, /copane-fast-output\n\[repeated \d+ more times\]\nfast-done/);
    assert.ok(out.length < 1000, `result is ${out.length} chars`);
  } finally {
    await closeAll(a);
    await a.close();
    await b.close();
  }
});

const labelOf = async a => JSON.parse(await a.ok('session_info')).you;

test('a session that comes back under a new label gets its terminal renamed', async () => {
  const a = await agent({ session: 'term-rename-a' });
  const others = [];
  try {
    const out = await a.ok('terminal_create', { name: 'build' });
    const id = termId(out);
    const before = await labelOf(a);
    // The user ends the session; other sessions start until one gets its number.
    await answerPrompts(['End Session']);
    await (await user()).ok('debug_vscode_command', { command: 'copane.ui.endSession', args: ['term-rename-a'] });
    for (let i = 0; i < 6; i++) {
      const other = await agent({ session: `term-rename-other-${i}` });
      others.push(other);
      if ((await labelOf(other)).label === before.label) break;
    }
    // The first agent goes on: a session under a new label, its terminal still its own (and active).
    const after = await until(async () => {
      const r = await a.call('session_info');
      return r.isError ? undefined : JSON.parse(r.text).you;
    }, 'session back');
    assert.notEqual(after.label, before.label);
    assert.equal(after.color, before.color);
    await (await user()).ok('debug_vscode_command', { command: 'workbench.action.terminal.focus' });
    const renamed = await until(async () => (await list(a)).find(t => t.id === id && t.name === `${after.label}: build`), `${id} renamed to "${after.label}: build"`);
    assert.equal(renamed.owner, 'you');
  } finally {
    await answerPrompts([]);
    await closeAll(a);
    await a.close();
    for (const o of others) await o.close();
  }
});

test('terminals stay with their session across a window reload, under the same label and color', async () => {
  const a = await agent({ session: 'term-reload' });
  const c = await agent({ session: 'term-reload-c' });
  const out = await a.ok('terminal_run', { command: 'echo before-reload' });
  const id = termId(out);
  const outC = await c.ok('terminal_create', { name: 'second' });
  const idC = termId(outC);
  const [youA, youC] = [await labelOf(a), await labelOf(c)];
  // VS Code saves its terminal layout lazily; a terminal created a moment before a reload is not revived.
  await sleep(6000);
  await a.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }).catch(() => {});
  await a.close().catch(() => {});
  await c.close().catch(() => {});
  userAgent = undefined;
  await sleep(4000);
  // The sessions come back in the other order, and a new one arrives first: labels must not shuffle.
  const reconnect = session =>
    until(async () => {
      try {
        const candidate = await agent({ session });
        const listed = await candidate.call('terminal_list');
        if (!listed.isError && listed.text.includes(id)) return candidate;
        await candidate.close();
      } catch {
        // The window is still reloading.
      }
      return undefined;
    }, 'window back after reload', { timeoutMs: 60_000, intervalMs: 1000 });
  const newcomer = await reconnect('term-reload-new');
  const c2 = await reconnect('term-reload-c');
  const b = await reconnect('term-reload');
  try {
    const [againA, againC, fresh] = [await labelOf(b), await labelOf(c2), await labelOf(newcomer)];
    assert.deepEqual([againA.label, againA.color], [youA.label, youA.color]);
    assert.deepEqual([againC.label, againC.color], [youC.label, youC.color]);
    assert.ok(![youA.label, youC.label].includes(fresh.label), `the new session got ${fresh.label}, a label of a returning one`);
    const terminals = await list(b);
    const mine = terminals.find(t => t.id === id);
    assert.equal(mine?.owner, 'you');
    assert.ok(mine.name.startsWith(youA.label), `${mine.name} should start with ${youA.label}`);
    const theirs = terminals.find(t => t.id === idC);
    assert.equal(theirs?.owner, youC.label);
    assert.equal(theirs.name, `${youC.label}: second`);
    const again = await b.ok('terminal_run', { command: 'echo after-reload' });
    assert.equal(termId(again), id);
    assert.match(again, /after-reload/);
  } finally {
    await closeAll(b);
    await closeAll(c2);
    await b.close();
    await c2.close();
    await newcomer.close();
  }
});

await run();
