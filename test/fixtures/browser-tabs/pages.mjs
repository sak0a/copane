// Looks at and clicks in integrated-browser pages the way the user would: through the dev host's own
// DevTools port (see scripts/dev-host.mjs, `ui-port`), not through the bridge. That connection is
// separate from the bridge's CDP sessions, so its input is "the user's" (the indicator does not turn
// click-through for it) and its reads take no lease.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function devToolsPort(hostDir) {
  return Number(readFileSync(join(hostDir, 'ui-port'), 'utf8'));
}

/** Connects to the page target whose URL is exactly `url` (or contains it, if no exact match). */
export async function openPage(hostDir, url) {
  const port = devToolsPort(hostDir);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
  const target = targets.find(t => t.url === url) ?? targets.find(t => t.url.includes(url));
  if (!target) throw new Error(`no page target for ${url}; have ${targets.map(t => t.url).join(', ')}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** All nodes of the indicator, closed shadow root included: { count, text, buttonCenter }. */
  async function indicator() {
    const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
    const hosts = [];
    const visit = (node, inside) => {
      const attrs = node.attributes ?? [];
      const isHost = attrs.includes('data-copane-ui');
      if (isHost) hosts.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child, inside || isHost);
    };
    visit(root, false);
    const texts = [];
    let button;
    let labelNode;
    const collect = node => {
      if (node.nodeType === 3 && node.nodeValue.trim()) texts.push(node.nodeValue.trim());
      if (node.nodeName === 'BUTTON') button ??= node;
      if (node.nodeName === 'SPAN' && (node.attributes ?? []).includes('label')) labelNode ??= node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) collect(child);
    };
    for (const host of hosts) collect(host);
    let buttonCenter;
    if (button) {
      try {
        const { model } = await send('DOM.getBoxModel', { backendNodeId: button.backendNodeId });
        const q = model.border;
        buttonCenter = { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
      } catch {
        // Not laid out (yet, or any more): no position to click.
      }
    }
    let labelCenter;
    if (labelNode) {
      try {
        const { model } = await send('DOM.getBoxModel', { backendNodeId: labelNode.backendNodeId });
        const q = model.border;
        labelCenter = { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
      } catch {
        // Not laid out.
      }
    }
    // Text minus the stylesheet (a <style> fallback would show up as text).
    return { count: hosts.length, text: texts.filter(t => !t.includes('{')).join(' '), buttonCenter, labelCenter };
  }

  return {
    send,
    indicator,
    /** A real (trusted) mouse click, as the user's. */
    /** A real mouse drag, as the user would do it. */
    async drag(fromX, fromY, toX, toY) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + ((toX - fromX) * i) / 8, y: fromY + ((toY - fromY) * i) / 8, button: 'left', buttons: 1 });
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1 });
    },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result.value;
    },
    close: () => ws.close(),
  };
}
