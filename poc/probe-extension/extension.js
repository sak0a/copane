// Feasibility probe: exposes VS Code integrated-browser tabs (proposed `browser` API + CDP)
// and integrated terminals (stable API + shell integration) over a token-protected local HTTP API.
// PoC only — not production code.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const log = vscode.window.createOutputChannel('VSC Probe');
const events = []; // lifecycle event log, returned by /events
function ev(kind, data) { const e = { t: Date.now(), kind, ...data }; events.push(e); log.appendLine(JSON.stringify(e)); }

// ---------- Browser ----------
const tabIds = new WeakMap(); let tabSeq = 0;
const idToTab = new Map();
function tabId(tab) {
  if (!tabIds.has(tab)) { const id = `tab-${++tabSeq}`; tabIds.set(tab, id); idToTab.set(id, tab); }
  return tabIds.get(tab);
}
function hasBrowserApi() { try { return Array.isArray(vscode.window.browserTabs); } catch { return false; } }
function describeTab(t) {
  return { id: tabId(t), url: t.url, title: t.title, active: vscode.window.activeBrowserTab === t };
}

const sessions = new Map(); // tabId -> { session, pending, seq, pageSessionId, events[] }
async function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const tab = idToTab.get(id);
  if (!tab || !vscode.window.browserTabs.includes(tab)) throw new Error(`unknown or closed tab ${id}`);
  const session = await tab.startCDPSession();
  const s = { session, pending: new Map(), seq: 0, pageSessionId: null, cdpEvents: [] };
  session.onDidReceiveMessage(msg => {
    if (msg && msg.id !== undefined && s.pending.has(msg.id)) {
      const { resolve, reject } = s.pending.get(msg.id); s.pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg && msg.method) {
      s.cdpEvents.push({ method: msg.method, sessionId: msg.sessionId, params: msg.params });
      if (s.cdpEvents.length > 300) s.cdpEvents.shift();
    }
  });
  session.onDidClose(() => { sessions.delete(id); ev('cdp-session-closed', { tab: id }); });
  s.send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++s.seq; s.pending.set(msgId, { resolve, reject });
    const m = { id: msgId, method, params: params || {} };
    if (sessionId) m.sessionId = sessionId;
    session.sendMessage(m).then(undefined, reject);
    setTimeout(() => { if (s.pending.has(msgId)) { s.pending.delete(msgId); reject(new Error(`timeout ${method}`)); } }, 15000);
  });
  // Bootstrap: browser target -> page target (flattened session).
  const { sessionId: browserSid } = await s.send('Target.attachToBrowserTarget');
  const { targetInfos } = await s.send('Target.getTargets', {}, browserSid);
  const page = targetInfos.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const { sessionId: pageSid } = await s.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, browserSid);
  s.pageSessionId = pageSid; s.targetId = page.targetId; s.targetInfos = targetInfos;
  await s.send('Runtime.enable', {}, pageSid);
  await s.send('Page.enable', {}, pageSid);
  sessions.set(id, s);
  ev('cdp-session-opened', { tab: id, targetId: page.targetId, targetsVisible: targetInfos.length });
  return s;
}
async function evaluate(id, expression) {
  const s = await getSession(id);
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s.pageSessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

// ---------- Terminals ----------
const termIds = new WeakMap(); let termSeq = 0; const idToTerm = new Map();
const agentOwned = new WeakSet();
function termId(t) { if (!termIds.has(t)) { const id = `term-${++termSeq}`; termIds.set(t, id); idToTerm.set(id, t); } return termIds.get(t); }
const lastEnd = new Map(); // termId -> {exitCode, commandLine, t}
function waitShellIntegration(term, ms) {
  if (term.shellIntegration) return Promise.resolve(term.shellIntegration);
  return new Promise(resolve => {
    const d = vscode.window.onDidChangeTerminalShellIntegration(e => { if (e.terminal === term) { d.dispose(); resolve(e.shellIntegration); } });
    setTimeout(() => { d.dispose(); resolve(term.shellIntegration); }, ms);
  });
}
function waitNextEnd(term, ms) {
  return new Promise(resolve => {
    const d = vscode.window.onDidEndTerminalShellExecution(e => {
      if (e.terminal === term) { d.dispose(); resolve({ exitCode: e.exitCode, commandLine: e.execution.commandLine.value }); }
    });
    setTimeout(() => { d.dispose(); resolve({ timeout: true }); }, ms);
  });
}

// ---------- HTTP ----------
const routes = {
  'GET /status': async () => ({
    vscode: vscode.version, browserApi: hasBrowserApi(), remoteName: vscode.env.remoteName ?? null,
    appHost: vscode.env.appHost, uiKind: vscode.env.uiKind, workspace: vscode.workspace.workspaceFolders?.map(f => f.uri.toString()),
    pid: process.pid, platform: process.platform,
  }),
  'GET /events': async () => events.slice(-100),
  'POST /commands': async b => (await vscode.commands.getCommands(true)).filter(c => c.includes(b.filter || 'browser')),
  'POST /command': async b => { const r = await vscode.commands.executeCommand(b.command, ...(b.args || [])); return r === undefined ? null : String(r); },
  'GET /tabs': async () => (hasBrowserApi() ? vscode.window.browserTabs.map(describeTab) : { error: 'browser proposal unavailable' }),
  'POST /tab/open': async b => describeTab(await vscode.window.openBrowserTab(b.url, { background: !!b.background, preserveFocus: true })),
  'POST /tab/close': async b => { await idToTab.get(b.tab).close(); return { closed: b.tab }; },
  'POST /cdp': async b => { const s = await getSession(b.tab); return s.send(b.method, b.params, b.root ? undefined : s.pageSessionId); },
  'POST /cdp/events': async b => { const s = await getSession(b.tab); return s.cdpEvents.slice(-(b.limit || 30)); },
  'POST /cdp/targets': async b => { const s = await getSession(b.tab); return { targetId: s.targetId, targetInfos: s.targetInfos }; },
  'POST /eval': async b => evaluate(b.tab, b.expression),
  // Two independent CDP sessions on one tab at the same time (simulates two agents without a gateway lease).
  'POST /concurrent': async b => {
    const tab = idToTab.get(b.tab);
    const [a, c] = await Promise.all([tab.startCDPSession(), tab.startCDPSession()]);
    const mk = sess => { let seq = 0; const pending = new Map();
      sess.onDidReceiveMessage(m => { if (m && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
      return (method, params, sessionId) => new Promise(r => { const id = ++seq; pending.set(id, r); sess.sendMessage({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }); }); };
    const sa = mk(a), sc = mk(c);
    const boot = async send => { const b1 = await send('Target.attachToBrowserTarget'); const t = await send('Target.getTargets', {}, b1.result.sessionId);
      const pg = t.result.targetInfos.find(x => x.type === 'page'); const at = await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }, b1.result.sessionId); return at.result.sessionId; };
    const [pa, pc] = await Promise.all([boot(sa), boot(sc)]);
    const ev2 = (send, sid, expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid).then(m => m.result?.result?.value ?? m.error);
    const r = await Promise.all([ev2(sa, pa, 'window.__a = "A"; location.href'), ev2(sc, pc, 'window.__c = "C"; location.href')]);
    const seen = await ev2(sa, pa, '[window.__a, window.__c].join(",")');
    await Promise.all([a.close(), c.close()]);
    return { bothConnected: true, results: r, sessionAseesBothWrites: seen };
  },
  'POST /navigate': async b => { const s = await getSession(b.tab); return s.send('Page.navigate', { url: b.url }, s.pageSessionId); },
  'POST /click': async b => {
    const s = await getSession(b.tab);
    const rect = await evaluate(b.tab, `(()=>{const r=document.querySelector(${JSON.stringify(b.selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await s.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, s.pageSessionId);
    return { clicked: b.selector, ...rect };
  },
  'POST /type': async b => {
    const s = await getSession(b.tab);
    await evaluate(b.tab, `document.querySelector(${JSON.stringify(b.selector)}).focus()`);
    await s.send('Input.insertText', { text: b.text }, s.pageSessionId);
    return { typed: b.text.length };
  },
  'POST /screenshot': async b => {
    const s = await getSession(b.tab);
    const { data } = await s.send('Page.captureScreenshot', { format: 'png' }, s.pageSessionId);
    const file = path.join(os.tmpdir(), `vsc-probe-${b.tab}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return { file, bytes: data.length };
  },
  'GET /terminals': async () => vscode.window.terminals.map(t => ({
    id: termId(t), name: t.name, agentOwned: agentOwned.has(t), shellIntegration: !!t.shellIntegration,
    cwd: t.shellIntegration?.cwd?.toString() ?? null, lastEnd: lastEnd.get(termId(t)) ?? null,
  })),
  'POST /terminal/create': async b => {
    const t = vscode.window.createTerminal({ name: b.name || 'Agent', cwd: b.cwd, isTransient: false });
    agentOwned.add(t); t.show(true);
    const si = await waitShellIntegration(t, 8000);
    return { id: termId(t), shellIntegration: !!si };
  },
  'POST /terminal/exec': async b => {
    const t = idToTerm.get(b.id); const si = await waitShellIntegration(t, 5000);
    if (!si) { t.sendText(b.command, true); return { mode: 'sendText-fallback', note: 'no shell integration: output/exit code unavailable' }; }
    const execution = si.executeCommand(b.command);
    const endP = new Promise(resolve => {
      const d = vscode.window.onDidEndTerminalShellExecution(e => { if (e.execution === execution) { d.dispose(); resolve(e.exitCode); } });
    });
    let output = '';
    const readP = (async () => { for await (const chunk of execution.read()) output += chunk; })();
    const timeout = new Promise(r => setTimeout(() => r('TIMEOUT'), b.timeoutMs || 20000));
    const exitCode = await Promise.race([endP, timeout]);
    await Promise.race([readP, new Promise(r => setTimeout(r, 300))]);
    return { exitCode, output };
  },
  'POST /terminal/send': async b => { idToTerm.get(b.id).sendText(b.text, b.newline !== false); return { sent: true }; },
  'POST /terminal/wait': async b => waitNextEnd(idToTerm.get(b.id), b.timeoutMs || 60000),
};

function activate(context) {
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
    if (req.headers['x-probe-token'] !== token) return reply(401, { error: 'bad token' });
    const route = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (!route) return reply(404, { error: 'no route' });
    let raw = ''; for await (const c of req) raw += c;
    try { reply(200, { ok: true, data: await route(raw ? JSON.parse(raw) : {}) }); }
    catch (e) { reply(500, { ok: false, error: String(e && e.stack || e) }); }
  });
  server.listen(0, '127.0.0.1', () => {
    const info = { port: server.address().port, token, pid: process.pid, workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath };
    fs.writeFileSync(path.join(os.tmpdir(), `vsc-probe-${process.pid}.json`), JSON.stringify(info), { mode: 0o600 });
    ev('listening', { port: info.port, browserApi: hasBrowserApi() });
  });
  context.subscriptions.push({ dispose: () => server.close() });

  if (hasBrowserApi()) {
    for (const t of vscode.window.browserTabs) ev('tab-existing', describeTab(t));
    context.subscriptions.push(
      vscode.window.onDidOpenBrowserTab(t => ev('tab-opened', describeTab(t))),
      vscode.window.onDidCloseBrowserTab(t => ev('tab-closed', { id: tabId(t) })),
      vscode.window.onDidChangeActiveBrowserTab(t => ev('tab-active', { id: t ? tabId(t) : null })),
      vscode.window.onDidChangeBrowserTabState(t => ev('tab-state', describeTab(t))),
    );
  }
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(t => ev('term-opened', { id: termId(t), name: t.name })),
    vscode.window.onDidEndTerminalShellExecution(e => {
      const id = termId(e.terminal); lastEnd.set(id, { exitCode: e.exitCode, commandLine: e.execution.commandLine.value, t: Date.now() });
      ev('term-exec-end', { id, exitCode: e.exitCode, commandLine: e.execution.commandLine.value });
    }),
  );
}
module.exports = { activate, deactivate() {} };
