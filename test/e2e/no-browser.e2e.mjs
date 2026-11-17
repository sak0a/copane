// A window whose integrated browser is not enabled for the extension: no browser_* tools are listed
// (they could only fail and every definition costs the agent context), the instructions are the short
// form, and both they and window_status tell the agent what to ask the user. Needs a dev host started
// without the proposed API:
//
//   node scripts/dev-host.mjs --name <n> --no-proposed
//   node test/e2e/no-browser.e2e.mjs --name <n>
import { agent, assert, run, test } from './harness.mjs';

const ENABLE = /"Copane: Enable Integrated Browser"/;

test('lists no browser tools, and terminal and session tools as usual', async () => {
  const a = await agent();
  try {
    const names = (await a.tools()).map(t => t.name);
    assert.deepEqual(
      names.filter(n => n.startsWith('browser_')),
      [],
      'this suite needs a dev host started with --no-proposed',
    );
    for (const name of ['session_info', 'terminal_run', 'window_status', 'window_select']) assert.ok(names.includes(name), `${name} is missing: ${names.join(', ')}`);
    assert.equal(JSON.parse(await a.ok('session_info')).browserAvailable, false);
  } finally {
    await a.close();
  }
});

test('the instructions leave out the browser guidance and say how to enable it', async () => {
  const a = await agent();
  try {
    const instructions = a.mcp.getInstructions() ?? '';
    assert.doesNotMatch(instructions, /^(Browser|Pages):/m);
    assert.match(instructions, /^Terminals:/m);
    assert.match(instructions, ENABLE);
    assert.ok(instructions.length < 1600, `instructions are ${instructions.length} characters:\n${instructions}`);
  } finally {
    await a.close();
  }
});

test('window_status says why there are no browser tools', async () => {
  const a = await agent();
  try {
    const status = await a.ok('window_status');
    assert.match(status, /Connected to VS Code window/);
    assert.match(status, ENABLE);
  } finally {
    await a.close();
  }
});

await run();
