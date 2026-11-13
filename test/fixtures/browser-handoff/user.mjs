// Plays the user in a tab handed to them: real clicks and typing through the dev host's own DevTools
// port (see ../browser-tabs/pages.mjs), never through the bridge, plus the buttons of the page
// indicator (inside its closed shadow root).
import { openPage } from '../browser-tabs/pages.mjs';

export async function asUser(hostDir, url) {
  const p = await openPage(hostDir, url);

  async function center(selector) {
    return p.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
  }

  /** The indicator's text and buttons ({ text, x, y }), read through the DOM with closed shadow roots pierced. */
  async function indicator() {
    const { root } = await p.send('DOM.getDocument', { depth: -1, pierce: true });
    const hosts = [];
    const findHosts = node => {
      if ((node.attributes ?? []).includes('data-copane-ui')) hosts.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) findHosts(child);
    };
    findHosts(root);
    const texts = [];
    const buttons = [];
    const collect = (node, inButton) => {
      if (node.nodeType === 3 && node.nodeValue.trim() && !node.nodeValue.includes('{')) (inButton ?? texts).push(node.nodeValue.trim());
      let target = inButton;
      if (node.nodeName === 'BUTTON') {
        target = [];
        buttons.push({ node, text: target });
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) collect(child, target);
    };
    for (const host of hosts) collect(host, undefined);
    const located = [];
    for (const b of buttons) {
      const text = b.text.join(' ');
      if (!text) continue;
      try {
        const { model } = await p.send('DOM.getBoxModel', { backendNodeId: b.node.backendNodeId });
        const q = model.border;
        located.push({ text, x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 });
      } catch {
        located.push({ text });
      }
    }
    return { count: hosts.length, text: texts.join(' '), buttons: located };
  }

  return {
    ...p,
    indicator,
    async clickOn(selector) {
      const c = await center(selector);
      if (!c) throw new Error(`no ${selector} on the page`);
      await p.click(c.x, c.y);
    },
    /** Clicks into the field and types, as the user would (trusted input events). */
    async type(selector, text) {
      await this.clickOn(selector);
      await p.send('Input.insertText', { text });
    },
    async clickIndicatorButton(label) {
      const { buttons } = await indicator();
      const button = buttons.find(b => b.text === label);
      if (!button || button.x === undefined) throw new Error(`no indicator button "${label}"; have ${JSON.stringify(buttons)}`);
      await p.click(button.x, button.y);
    },
  };
}
