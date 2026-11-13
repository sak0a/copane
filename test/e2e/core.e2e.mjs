// Sessions and the bridge itself, against a running dev host.
import { agent, assert, run, test } from './harness.mjs';

test('two agent sessions get their own label and see each other', async () => {
  const a = await agent({ session: 'core-a' });
  const b = await agent({ session: 'core-b' });
  try {
    const infoA = JSON.parse(await a.ok('session_info'));
    const infoB = JSON.parse(await b.ok('session_info'));
    assert.notEqual(infoA.you.label, infoB.you.label);
    assert.notEqual(infoA.you.color, infoB.you.color);
    assert.ok(infoA.otherSessions.some(s => s.label.startsWith(infoB.you.label)));
  } finally {
    await a.close();
    await b.close();
  }
});

test('a session keeps its identity when it reconnects with the same key', async () => {
  const first = await agent({ session: 'core-resume' });
  await first.ok('session_set_title', { title: 'resume check' });
  const before = JSON.parse(await first.ok('session_info')).you;
  await first.close();
  const second = await agent({ session: 'core-resume' });
  try {
    assert.deepEqual(JSON.parse(await second.ok('session_info')).you, before);
  } finally {
    await second.close();
  }
});

test('tool arguments are validated with a readable message', async () => {
  const a = await agent();
  try {
    const result = await a.call('session_set_title', { title: 42 });
    assert.ok(result.isError);
    assert.match(result.text, /title/);
  } finally {
    await a.close();
  }
});

await run();
