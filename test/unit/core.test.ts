import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolError } from '../../src/extension/core/errors';
import { LeaseManager } from '../../src/extension/core/leases';
import { nullLogger } from '../../src/extension/core/log';
import { SessionManager } from '../../src/extension/core/sessions';
import { defineTool, ToolRegistry } from '../../src/extension/core/tools';

const claude = { name: 'claude-code', kind: 'claude-code' as const };

describe('SessionManager', () => {
  it('numbers sessions per agent kind and gives them distinct colors', () => {
    const m = new SessionManager();
    const s1 = m.connect({ sessionKey: 'a', client: claude });
    const s2 = m.connect({ sessionKey: 'b', client: claude });
    const s3 = m.connect({ sessionKey: 'c', client: { name: 'codex', kind: 'codex' } });
    expect([s1.label, s2.label, s3.label]).toEqual(['Claude 1', 'Claude 2', 'Codex 1']);
    expect([s1.badge, s2.badge, s3.badge]).toEqual(['C1', 'C2', 'C1']);
    expect(new Set([s1.color.id, s2.color.id, s3.color.id]).size).toBe(3);
  });

  it('labels Copilot sessions "Copilot n" with a badge of their own', () => {
    const m = new SessionManager();
    const copilot = { name: 'copilot-cli', kind: 'copilot' as const };
    const sessions = [
      m.connect({ sessionKey: 'a', client: claude }),
      m.connect({ sessionKey: 'b', client: copilot }),
      m.connect({ sessionKey: 'c', client: copilot }),
      m.connect({ sessionKey: 'd', client: { name: 'other', kind: 'other' } }),
    ];
    expect(sessions.map(s => s.label)).toEqual(['Claude 1', 'Copilot 1', 'Copilot 2', 'Agent 1']);
    expect(sessions.map(s => s.badge)).toEqual(['C1', 'G1', 'G2', 'A1']);
    for (const s of sessions) expect(s.badge.length).toBeLessThanOrEqual(2);
  });

  it('resumes a session that reconnects with the same key', () => {
    const m = new SessionManager({ graceMs: () => 60_000 });
    const first = m.connect({ sessionKey: 'a', client: claude });
    m.disconnect('a');
    expect(first.connected).toBe(false);
    expect(m.connect({ sessionKey: 'a', client: claude })).toBe(first);
    expect(first.connected).toBe(true);
    m.dispose();
  });

  it('removes a session immediately when there is no grace period and reuses its number', () => {
    const m = new SessionManager({ graceMs: () => 0 });
    const events: string[] = [];
    m.onDidChange(e => events.push(e.type));
    m.connect({ sessionKey: 'a', client: claude });
    m.disconnect('a');
    expect(m.list()).toEqual([]);
    expect(events).toEqual(['added', 'updated', 'removed']);
    expect(m.connect({ sessionKey: 'b', client: claude }).label).toBe('Claude 1');
  });

  it('keeps a session while one of two connections with the same key is still open', () => {
    const m = new SessionManager({ graceMs: () => 0 });
    m.connect({ sessionKey: 'a', client: claude });
    m.connect({ sessionKey: 'a', client: claude });
    m.disconnect('a');
    expect(m.get('a')?.connected).toBe(true);
    m.disconnect('a');
    expect(m.get('a')).toBeUndefined();
  });
});

describe('LeaseManager', () => {
  it('lets one session hold a resource and others take it once idle', () => {
    let now = 0;
    const leases = new LeaseManager({ idleMs: () => 100, now: () => now });
    expect(leases.acquire('tab-1', 'a').ok).toBe(true);
    expect(leases.acquire('tab-1', 'b')).toMatchObject({ ok: false, heldBy: { sessionId: 'a' } });
    now = 50;
    expect(leases.acquire('tab-1', 'a').ok).toBe(true); // renews
    now = 120;
    expect(leases.acquire('tab-1', 'b').ok).toBe(false); // 70 ms since renewal
    now = 151;
    expect(leases.acquire('tab-1', 'b')).toMatchObject({ ok: true, lease: { sessionId: 'b' } });
  });

  it('releases only for the holder and releases everything a session holds', () => {
    const leases = new LeaseManager();
    leases.acquire('tab-1', 'a');
    leases.acquire('tab-2', 'a');
    expect(leases.release('tab-1', 'b')).toBe(false);
    expect(leases.releaseAllOf('a').sort()).toEqual(['tab-1', 'tab-2']);
    expect(leases.holder('tab-1')).toBeUndefined();
  });
});

describe('ToolRegistry', () => {
  const session = new SessionManager().connect({ sessionKey: 'a', client: claude });
  const ctx = { session, signal: new AbortController().signal, log: nullLogger };
  const registry = new ToolRegistry();
  registry.register([
    defineTool({
      name: 'echo',
      description: 'Echoes.',
      input: { message: z.string().describe('What to echo'), times: z.number().int().optional() },
      handler: args => {
        if (args.message === 'boom') throw new ToolError('failed', 'It went boom. Try another message.');
        return args.message.repeat(args.times ?? 1);
      },
    }),
  ]);

  it('exposes a JSON schema for the arguments', () => {
    const [tool] = registry.list();
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['message'], properties: { message: { type: 'string', description: 'What to echo' } } });
  });

  it('returns text results and turns failures into isError results', async () => {
    expect(await registry.call('echo', { message: 'hi', times: 2 }, ctx)).toEqual({ content: [{ type: 'text', text: 'hihi' }] });
    expect(await registry.call('echo', { message: 'boom' }, ctx)).toEqual({ content: [{ type: 'text', text: 'It went boom. Try another message.' }], isError: true });
    expect((await registry.call('echo', {}, ctx)).isError).toBe(true);
    expect((await registry.call('nope', {}, ctx)).isError).toBe(true);
  });

  it('advertises upper bounds but not lower bounds, closed nested objects or string record keys; zod still checks them', async () => {
    const bounded = new ToolRegistry();
    bounded.register([
      defineTool({
        name: 'bounded',
        description: 'Bounds.',
        input: {
          command: z.string().min(1).max(500),
          seconds: z.number().int().min(1).max(300).optional(),
          // Parameters named like keywords are parameters, not keywords.
          minimum: z.number().min(0).optional(),
          items: z.array(z.object({ name: z.string().min(1) })).min(1).max(5).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          mode: z.enum(['a', 'b']).optional(),
        },
        handler: () => 'ok',
      }),
    ]);
    const schema = bounded.list()[0]!.inputSchema;
    const wire = JSON.stringify(schema);
    expect(wire).not.toMatch(/"minimum"\s*:\s*-?\d|"minLength"|"minItems"|"propertyNames"|"additionalProperties":false|9007199254740991/);
    expect(schema).toMatchObject({
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', maxLength: 500 },
        seconds: { type: 'integer', maximum: 300 },
        minimum: { type: 'number' },
        items: { type: 'array', maxItems: 5, items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        mode: { enum: ['a', 'b'] },
      },
    });
    for (const [args, field] of [
      [{ command: '' }, 'command'],
      [{ command: 'x', seconds: 0 }, 'seconds'],
      [{ command: 'x', items: [] }, 'items'],
      [{ command: 'x', items: [{ name: '' }] }, 'items'],
    ] as const) {
      const result = await bounded.call('bounded', args, ctx);
      expect(result.isError).toBe(true);
      const message = (result.content[0] as { text: string }).text;
      expect(message).toMatch(/Too small/);
      expect(message).toContain(field);
    }
  });
});

describe('base hardening', () => {
  it('registers a batch of tools all or nothing', () => {
    const registry = new ToolRegistry();
    const tool = (name: string) => defineTool({ name, description: 'x', input: {}, handler: () => 'ok' });
    registry.register([tool('a')]);
    expect(() => registry.register([tool('b'), tool('a')])).toThrow(/already registered/);
    expect(registry.list().map(t => t.name)).toEqual(['a']);
    expect(() => registry.register([tool('c'), tool('c')])).toThrow(/already registered/);
    expect(registry.list().map(t => t.name)).toEqual(['a']);
  });

  it('releases idle leases on a sweep and reports the change', () => {
    let now = 0;
    const leases = new LeaseManager({ idleMs: () => 100, now: () => now });
    const changes: Array<string | undefined> = [];
    leases.onDidChange(c => changes.push(c.lease?.sessionId));
    leases.acquire('tab-1', 'a');
    now = 99;
    expect(leases.releaseIdle()).toEqual([]);
    now = 100;
    expect(leases.releaseIdle()).toEqual(['tab-1']);
    expect(leases.holder('tab-1')).toBeUndefined();
    expect(changes).toEqual(['a', undefined]);
  });
});
