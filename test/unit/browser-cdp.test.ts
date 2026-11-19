// CdpConnection against a stand-in for VS Code's CDP session: what a failed command means for the
// connection. The page session survives a navigation, so "Inspected target navigated or closed" must
// not close it unless the page really no longer answers.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { CdpConnection } from '../../src/extension/browser/cdp';

type Answer = { result?: unknown; error?: string } | undefined;

/** A session that answers each command with what `answer` returns (undefined: no answer at all). */
function fakeTab(answer: (method: string) => Answer) {
  let onMessage: (m: unknown) => void = () => {};
  const sent: string[] = [];
  const session = {
    onDidReceiveMessage(listener: (m: unknown) => void) {
      onMessage = listener;
      return { dispose() {} };
    },
    onDidClose: () => ({ dispose() {} }),
    sendMessage(message: { id: number; method: string }) {
      sent.push(message.method);
      const setup: Record<string, unknown> = {
        'Target.attachToBrowserTarget': { sessionId: 'browser' },
        'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'T1' }] },
        'Target.attachToTarget': { sessionId: 'page' },
      };
      const a: Answer = message.method in setup ? { result: setup[message.method] } : answer(message.method);
      if (a) queueMicrotask(() => onMessage({ id: message.id, ...(a.error ? { error: { message: a.error } } : { result: a.result ?? {} }) }));
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return { tab: { startCDPSession: async () => session } as any, sent };
}

const NAVIGATED = 'Inspected target navigated or closed';

describe('CdpConnection: a command that fails because its document went away', () => {
  it('asks again while the browser is between two documents', async () => {
    let probes = 0;
    const { tab } = fakeTab(method => {
      if (method === 'Runtime.evaluate') return { error: NAVIGATED };
      if (method === 'Page.getNavigationHistory') return ++probes < 3 ? { error: 'Not attached to an active page' } : { result: {} };
      return { result: {} };
    });
    const page = await CdpConnection.attach('tab-1', tab);
    await expect(page.send('Runtime.evaluate', {})).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('navigated while') });
    expect(probes).toBe(3);
    expect(page.closed).toBe(false);
  });

  it('keeps the connection when the page still answers, and says the page navigated', async () => {
    const { tab, sent } = fakeTab(method => (method === 'Runtime.evaluate' ? { error: NAVIGATED } : { result: {} }));
    const page = await CdpConnection.attach('tab-1', tab);
    await expect(page.send('Runtime.evaluate', {})).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('tab-1 navigated while') });
    expect(page.closed).toBe(false);
    expect(sent).toContain('Page.getNavigationHistory');
    await expect(page.send('Page.enable', {})).resolves.toEqual({});
  });

  it('closes the connection when the page no longer answers', async () => {
    const { tab } = fakeTab(method => (method === 'Runtime.evaluate' ? { error: NAVIGATED } : { error: 'Session with given id not found.' }));
    const page = await CdpConnection.attach('tab-1', tab);
    await expect(page.send('Runtime.evaluate', {})).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('Lost the connection') });
    expect(page.closed).toBe(true);
  });

  it('still closes at once on errors that only mean the session is gone', async () => {
    const { tab, sent } = fakeTab(() => ({ error: 'No target with given id found' }));
    const page = await CdpConnection.attach('tab-1', tab);
    await expect(page.send('Runtime.evaluate', {})).rejects.toMatchObject({ message: expect.stringContaining('Lost the connection') });
    expect(page.closed).toBe(true);
    expect(sent).not.toContain('Page.getNavigationHistory');
  });
});
