import { describe, expect, it } from 'vitest';
import {
  conditionHolds,
  describeOutcome,
  describePage,
  describePrivacy,
  looksLikeSignIn,
  parseProbe,
  probeExpression,
  urlHolds,
  validateDoneWhen,
} from '../../src/extension/browser/handoffLogic';
import { formatNetworkEntry, NetworkLog, withheldUrl } from '../../src/extension/browser/page/networkLog';
import { ConsoleLog } from '../../src/extension/browser/page/consoleLog';
import type { PageState } from '../../src/extension/browser/page/pageState';
import { withholdEntry, withholdSince } from '../../src/extension/browser/page/privacy';
import type { BrowserTabInfo } from '../../src/extension/core/services';
import { SESSION_COLORS, type AgentSession } from '../../src/extension/core/sessions';
import { buildViewModel, tabState } from '../../src/extension/ui/model';
import { buildPanelModel } from '../../src/extension/ui/panelModel';

describe('done_when', () => {
  it('rejects an empty condition, a broken regex and selectors that test field values', () => {
    expect(validateDoneWhen(undefined)).toBeUndefined();
    expect(validateDoneWhen({ url: '/dashboard' })).toBeUndefined();
    expect(validateDoneWhen({})).toMatch(/at least one of/);
    expect(validateDoneWhen({ url: '/(/' })).toMatch(/^done_when\.url: Invalid regular expression/);
    expect(validateDoneWhen({ selector: 'input[type=password][value^="a"]' })).toMatch(/cannot test field values/);
    expect(validateDoneWhen({ selector: 'input[ VALUE*=x]' })).toMatch(/cannot test field values/);
    expect(validateDoneWhen({ selector: '#app [data-value]' })).toBeUndefined();
  });

  it('matches the URL without its query, so a return address in a sign-in URL does not count', () => {
    expect(urlHolds('/dashboard', 'https://corp/login?next=/dashboard')).toBe(false);
    expect(urlHolds('/dashboard', 'https://corp/dashboard?tab=1')).toBe(true);
    expect(urlHolds('jira.corp/secure/*', 'https://jira.corp/secure/Dashboard.jspa')).toBe(false);
    expect(urlHolds('https://jira.corp/secure/*', 'https://jira.corp/secure/Dashboard.jspa')).toBe(true);
    expect(urlHolds('login.microsoftonline.com', 'https://login.microsoftonline.com/x/oauth2/authorize?redirect_uri=https://jira.corp/')).toBe(true);
    expect(urlHolds('jira.corp', 'https://login.microsoftonline.com/x/oauth2/authorize?redirect_uri=https://jira.corp/')).toBe(false);
    // A regex sees the whole URL.
    expect(urlHolds('/[?&]code=/', 'https://app/callback?code=1')).toBe(true);
  });

  it('holds only when every given part holds', () => {
    const probe = { href: 'https://corp/dashboard', text: true, gone: false, selector: true as const };
    expect(conditionHolds({ url: '/dashboard' }, probe)).toBe(true);
    expect(conditionHolds({ url: '/dashboard', text: 'Welcome' }, probe)).toBe(true);
    expect(conditionHolds({ url: '/dashboard', gone: 'Sign in' }, probe)).toBe(false);
    expect(conditionHolds({ selector: '#app' }, { href: 'x', selector: 'invalid' })).toBe(false);
    expect(conditionHolds({ text: 'Welcome' }, { href: 'x' })).toBe(false);
  });

  it('builds a probe that only asks for what the condition needs and never reads field values', () => {
    const expression = probeExpression({ text: 'Welcome', selector: '#app' }, false);
    expect(expression).toContain('const TEXT = "welcome", GONE = null, SEL = "#app"');
    expect(expression).toContain('if (false)');
    expect(expression).not.toMatch(/\.value\b/);
    expect(probeExpression(undefined, true)).toContain('if (true)');
    expect(parseProbe('{"href":"https://x/","title":"X","ready":"complete","visible":true}')).toMatchObject({ href: 'https://x/', visible: true });
    expect(parseProbe('nope')).toBeUndefined();
    expect(parseProbe(3)).toBeUndefined();
  });
});

describe('what the agent is told', () => {
  it('says how the hand-off ended and what to do next', () => {
    expect(describeOutcome({ kind: 'condition' }, 'tab-3', 42_000)).toBe('done_when matched after 42 s: the user finished in tab-3, which is yours again.');
    expect(describeOutcome({ kind: 'done', via: 'page' }, 'tab-3', 5_000)).toBe('The user said they are done (after 5 s); tab-3 is yours again.');
    expect(describeOutcome({ kind: 'declined', via: 'page' }, 'tab-3', 5_000)).toMatch(/^The user declined \("Won't do"\) after 5 s; tab-3 is yours again\. Do not ask again/);
    expect(describeOutcome({ kind: 'timeout' }, 'tab-3', 600_000)).toBe('No answer from the user within 10 min; the request was withdrawn and tab-3 is yours again. Ask the user in chat before trying again.');
    expect(describeOutcome({ kind: 'closed' }, 'tab-3', 1_000)).toMatch(/^The user closed tab-3/);
  });

  it('describes where the page is now, and warns when a sign-in form is still there', () => {
    const probe = { href: 'https://jira/secure/Dashboard.jspa', title: 'System Dashboard - Jira', ready: 'complete', visible: true, heading: 'System Dashboard - Jira', passwords: 0 };
    expect(describePage(probe, '', { kind: 'condition' })).toBe('Page now: https://jira/secure/Dashboard.jspa — "System Dashboard - Jira".');
    expect(describePage({ ...probe, heading: 'Welcome', ready: 'interactive' }, '', { kind: 'condition' })).toBe('Page now: https://jira/secure/Dashboard.jspa — "System Dashboard - Jira", heading "Welcome" (still loading).');
    expect(describePage({ ...probe, passwords: 1 }, '', { kind: 'done', via: 'page' })).toMatch(/still shows a password field, so the sign-in may not be complete\.$/);
    expect(describePage({ ...probe, passwords: 1 }, '', { kind: 'declined', via: 'page' })).not.toMatch(/password/);
    expect(describePage(undefined, 'https://x/', { kind: 'timeout' })).toBe('Page now: https://x/.');
  });

  it('says what was kept private', () => {
    expect(describePrivacy({ requests: 0, messages: 0 }, 0)).toBe('');
    expect(describePrivacy({ requests: 1, messages: 0 }, 0)).toBe('While the user had the tab, the request it sent is listed without URL query, headers or bodies.');
    expect(describePrivacy({ requests: 3, messages: 2 }, 1)).toBe(
      'While the user had the tab, the 3 requests it sent are listed without URL query, headers or bodies; its 2 console messages are withheld; a password or code field still on the page was emptied.',
    );
  });
});

describe('sign-in pages', () => {
  it('are recognised by a visible password field, an identity provider or a login path', () => {
    expect(looksLikeSignIn('https://app.example.com/settings', 1)).toBe(true);
    expect(looksLikeSignIn('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x', 0)).toBe(true);
    expect(looksLikeSignIn('https://corp.okta.com/app/x', 0)).toBe(true);
    expect(looksLikeSignIn('https://sso.corp.example/idp/x', 0)).toBe(true);
    expect(looksLikeSignIn('https://jira.corp/login.jsp', 0)).toBe(true);
    expect(looksLikeSignIn('https://confluence.corp/login.action?os_destination=x', 0)).toBe(true);
    expect(looksLikeSignIn('https://bitbucket.corp/signin', 0)).toBe(true);
    expect(looksLikeSignIn('https://keycloak.corp/realms/x/protocol/openid-connect/auth?x', 0)).toBe(true);
    expect(looksLikeSignIn('https://adfs.corp/adfs/ls/?wa=wsignin1.0', 0)).toBe(true);
    expect(looksLikeSignIn('https://jira.corp/secure/Dashboard.jspa', 0)).toBe(false);
    expect(looksLikeSignIn('https://blog.example/how-to-login-faster', 0)).toBe(false);
    expect(looksLikeSignIn('about:blank', 0)).toBe(false);
  });
});

describe('requests sent while the user had the tab', () => {
  const request = (log: NetworkLog, id: string) =>
    log.onRequest({
      requestId: id,
      request: { url: 'https://idp/token?code=SECRETCODE#state=x', method: 'POST', headers: { authorization: 'Bearer abc', 'content-type': 'application/json' }, postData: '{"password":"hunter2"}' },
      timestamp: 1,
      type: 'Fetch',
    })!;

  it('lose URL query, headers and bodies, also those that arrive later', () => {
    let seq = 0;
    const log = new NetworkLog(10, () => ++seq);
    const entry = request(log, 'r-1');
    withholdEntry(entry);
    log.onRequestExtra({ requestId: 'r-1', headers: { cookie: 'sid=1', authorization: 'Bearer abc' } });
    log.onResponse({ requestId: 'r-1', response: { status: 200, headers: { 'set-cookie': 'sid=2' }, mimeType: 'application/json' } });
    log.onRequest({ requestId: 'r-1', request: { url: 'https://app/next?token=T', method: 'GET' }, timestamp: 2, redirectResponse: { status: 302, headers: { location: 'https://app/next?token=T' } } });
    expect(entry).toMatchObject({ withheld: true, url: 'https://idp/token?…', requestHeaders: undefined, responseHeaders: undefined, postData: undefined, hasPostData: true, redirectedTo: 'https://app/next?…' });
    const line = formatNetworkEntry(entry, 10);
    expect(line).toContain('sent while the user had the tab: details withheld');
    expect(line).not.toMatch(/SECRETCODE|hunter2|token=T/);
  });

  it('a request from before the hand-off that redirected into it loses that hop', () => {
    let seq = 0;
    const network = new NetworkLog(10, () => ++seq);
    const consoleLog = new ConsoleLog(10, () => ++seq);
    const before = network.onRequest({ requestId: 'nav', request: { url: 'https://app/', method: 'GET' }, timestamp: 1, type: 'Document' })!;
    const other = network.onRequest({ requestId: 'img', request: { url: 'https://app/a.png?v=1', method: 'GET' }, timestamp: 1, type: 'Image' })!;
    const mark = seq;
    network.onRequest({ requestId: 'nav', request: { url: 'https://idp/authorize?login_hint=alice', method: 'GET' }, timestamp: 2, redirectResponse: { status: 302, headers: { location: 'https://idp/authorize?login_hint=alice' } } });
    const counts = withholdSince({ network, console: consoleLog } as unknown as PageState, mark);
    expect(counts).toEqual({ requests: 1, messages: 0 });
    expect(before).toMatchObject({ url: 'https://app/', redirectedTo: 'https://idp/authorize?…', responseHeaders: undefined });
    expect(before.withheld).toBeUndefined();
    expect(other.url).toBe('https://app/a.png?v=1');
  });

  it('other requests keep their details', () => {
    let seq = 0;
    const log = new NetworkLog(10, () => ++seq);
    const entry = request(log, 'r-2');
    log.onResponse({ requestId: 'r-2', response: { status: 200, headers: { 'x-a': '1' } } });
    expect(entry.withheld).toBeUndefined();
    expect(entry.postData).toBe('{"password":"hunter2"}');
    expect(entry.responseHeaders).toEqual({ 'x-a': '1' });
    expect(withheldUrl('https://a/b')).toBe('https://a/b');
    expect(withheldUrl('https://a/b#x')).toBe('https://a/b#…');
  });
});

describe('a tab waiting for the user in the views', () => {
  const session = (n: number): AgentSession => ({
    id: `s${n}`,
    client: { name: 'claude-code', version: '2.1.0', kind: 'claude-code' },
    number: n,
    label: `Claude ${n}`,
    autoLabel: `Claude ${n}`,
    badge: `C${n}`,
    color: SESSION_COLORS[n - 1]!,
    title: undefined,
    pid: 1000 + n,
    cwd: '/work',
    createdAt: n,
    lastActivityAt: n,
    connected: true,
  });
  const waiting: BrowserTabInfo = {
    id: 'tab-4',
    url: 'https://login.microsoftonline.com/x',
    title: 'Sign in to your account',
    active: true,
    origin: 'agent',
    openedBy: 's1',
    controlledBy: undefined,
    allowedSessions: ['s1'],
    paused: true,
    request: { sessionId: 's1', message: 'Sign in to Jira with your company account.', since: 1 },
  };
  const s1 = session(1);
  const s2 = session(2);

  it('counts and looks like a terminal waiting for the user', () => {
    const model = buildViewModel({ sessions: [s1, s2], tabs: [waiting, { ...waiting, id: 'tab-5', request: undefined, openedBy: 's2', allowedSessions: ['s2'] }], terminals: [], browserAvailable: true, graceSeconds: 20 });
    expect(tabState(waiting, 's1')).toBe('waiting-for-user');
    const row = model.nodes.get('session:s1/tab:tab-4')!;
    expect(row.description).toBe('waiting for you: Sign in to Jira with your company account. · login.microsoftonline.com');
    expect(row.icon).toEqual({ id: 'bell-dot', color: 'list.warningForeground' });
    expect(row.contextValue.split(' ')).toEqual(expect.arrayContaining(['tab', 'waitingForUser']));
    expect(row.contextValue.split(' ')).not.toContain('paused');
    expect(model.nodes.get('session:s1')!.description).toBe('needs you');
    expect(model.attention[0]).toMatchObject({ kind: 'tab', targetId: 'tab-4', label: 'Claude 1 is waiting for you', description: 'Sign in to your account', detail: 'Sign in to Jira with your company account.', waiting: true });
    expect(model.attention[1]).toMatchObject({ kind: 'tab', targetId: 'tab-5', label: '"Sign in to your account" is paused' });
    expect(model.badge).toEqual({ value: 2, tooltip: '1 tab is waiting for you, 1 tab is paused' });
    expect(model.status).toMatchObject({ text: '$(bell-dot) Claude 1 needs you', warning: true });
    expect(model.status.accessibilityLabel).toBe('Copane: 2 agent sessions connected, 1 tab waiting for you, 1 tab paused');
  });

  it('shows in the Agent Tabs view under the session that asked', () => {
    const user: BrowserTabInfo = { ...waiting, origin: 'user', openedBy: undefined, allowedSessions: ['s1', 's2'], request: { ...waiting.request!, sessionId: 's2' } };
    const panel = buildPanelModel({ sessions: [s1, s2], tabs: [user] });
    expect(panel.roots[0]!.description).toMatch(/^Claude 2 · waiting for you: Sign in to Jira with your company account\. · your tab/);
    expect(panel.roots[0]!.icon.id).toBe('bell-dot');
    expect(panel.roots[0]!.contextValue.split(' ')).toContain('waitingForUser');
  });
});
