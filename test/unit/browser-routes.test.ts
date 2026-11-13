import { describe, expect, it } from 'vitest';
import { applyHeaderChanges, decisionFor, describeRule, fetchPatternFor, guessContentType, ruleMatches, validateRoute, type RouteRule } from '../../src/extension/browser/routeRules';

function rule(input: Parameters<typeof validateRoute>[0]): RouteRule {
  const v = validateRoute(input);
  if (!v.ok) throw new Error(v.error);
  return { ...v.rule, id: 'm1', sessionId: 's1', tabId: 'tab-1' };
}

describe('validateRoute', () => {
  it('needs a url and something to do', () => {
    expect(validateRoute({})).toMatchObject({ ok: false, error: expect.stringMatching(/Pass url/) });
    expect(validateRoute({ url: '*/api*' })).toMatchObject({ ok: false, error: expect.stringMatching(/Say what to do/) });
  });

  it('rejects contradictory combinations', () => {
    expect(validateRoute({ url: 'x', status: 500, fail: 'refused' })).toMatchObject({ ok: false, error: expect.stringMatching(/either a response/) });
    expect(validateRoute({ url: 'x', body: '{}', setHeaders: { a: 'b' } })).toMatchObject({ ok: false, error: expect.stringMatching(/setHeaders/) });
    expect(validateRoute({ url: '/(/' })).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid regular expression/) });
  });

  it('builds fulfil, fail and pass-through rules', () => {
    expect(rule({ url: 'api/cart', status: 500 })).toMatchObject({ kind: 'fulfill', status: 500, body: '' });
    expect(rule({ url: 'api/cart', body: '{"a":1}' })).toMatchObject({ kind: 'fulfill', status: 200, headers: { 'content-type': 'application/json' } });
    expect(rule({ url: 'api/cart', body: 'x', headers: { 'Content-Type': 'text/csv' } }).headers).toEqual({ 'Content-Type': 'text/csv' });
    expect(rule({ url: 'api/cart', fail: 'offline' })).toMatchObject({ kind: 'fail' });
    expect(rule({ url: 'api/cart', delay: 500 })).toMatchObject({ kind: 'continue', delayMs: 500 });
    expect(rule({ url: 'api/cart', setHeaders: { 'x-a': '1' }, method: 'post', times: 2 })).toMatchObject({ kind: 'continue', method: 'POST', remaining: 2 });
  });
});

describe('matching', () => {
  it('matches globs over the whole URL, regexes and substrings, and the method', () => {
    const glob = rule({ url: '*/api/cart*', status: 500 });
    expect(ruleMatches(glob, { url: 'http://a/api/cart?x=1', method: 'GET' })).toBe(true);
    expect(ruleMatches(glob, { url: 'http://a/api/carts', method: 'GET' })).toBe(true);
    expect(ruleMatches(glob, { url: 'http://a/v2/api/order', method: 'GET' })).toBe(false);
    const re = rule({ url: '/\\/api\\/cart$/', status: 500, method: 'POST' });
    expect(ruleMatches(re, { url: 'http://a/api/cart', method: 'post' })).toBe(true);
    expect(ruleMatches(re, { url: 'http://a/api/cart', method: 'GET' })).toBe(false);
    expect(ruleMatches(rule({ url: 'api/cart', status: 500 }), { url: 'http://a/api/cart/1', method: 'GET' })).toBe(true);
  });

  it('pauses at least what the rule matches', () => {
    expect(fetchPatternFor('*/api/cart*')).toEqual({ urlPattern: '*/api/cart*' });
    expect(fetchPatternFor('api/cart')).toEqual({ urlPattern: '*api/cart*' });
    expect(fetchPatternFor('/cart$/i')).toEqual({ urlPattern: '*' });
  });
});

describe('decisions', () => {
  it('turns rules into interception decisions with a note for the network log', () => {
    expect(decisionFor(rule({ url: 'x', status: 503, body: 'down', delay: 100 }), { headers: {} }, 'Claude 1')).toEqual({
      kind: 'fulfill',
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'down',
      delayMs: 100,
      note: 'mocked by m1 (Claude 1)',
    });
    expect(decisionFor(rule({ url: 'x', fail: 'refused' }), { headers: {} }, '')).toEqual({ kind: 'fail', reason: 'ConnectionRefused', delayMs: undefined, note: 'mocked by m1' });
    expect(decisionFor(rule({ url: 'x', delay: 2000 }), { headers: { a: '1' } }, '')).toEqual({ kind: 'continue', headers: undefined, delayMs: 2000, note: 'delayed by m1' });
  });

  it('changes request headers case-insensitively, null removes', () => {
    expect(applyHeaderChanges({ Accept: 'a', 'X-Old': '1', Keep: 'k' }, { accept: 'b', 'x-old': null, 'X-New': 'n' })).toEqual({ Keep: 'k', accept: 'b', 'X-New': 'n' });
  });

  it('guesses a content type from the body', () => {
    expect(guessContentType('[1,2]')).toBe('application/json');
    expect(guessContentType('{not json')).toBe('text/plain; charset=utf-8');
    expect(guessContentType('<!doctype html><p>x')).toMatch(/text\/html/);
  });

  it('describes a rule in one line', () => {
    const r = rule({ url: '*/api/cart*', method: 'get', status: 500, body: '{"error":"boom"}', delay: 2000, times: 3 });
    r.hits = 1;
    expect(describeRule(r)).toBe('m1  GET */api/cart*  → 500, application/json, 16 B, after 2 s  (1 hit, 3 left)');
    expect(describeRule(rule({ url: 'x', setHeaders: { 'x-a': '1', b: null } }))).toBe('m1  any x  → sent on with x-a: 1, -b  (0 hits)');
  });
});
