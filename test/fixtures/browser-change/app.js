// A stand-in for a dev server's client (see server.mjs): listens for edits on /events and applies
// them the way Vite's client would, printing the same console lines.
const panel = document.getElementById('panel');

console.log('[vite] connecting...');
const events = new EventSource('/events');
events.addEventListener('open', () => console.log('[vite] connected.'), { once: true });

class ErrorOverlay extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { position: fixed; inset: 0; z-index: 99999; background: rgba(0, 0, 0, 0.66); }
      .window { margin: 60px auto; max-width: 640px; padding: 20px; background: #181818; color: #d8d8d8; font: 14px monospace; }
      .message-body { color: #ff5555; }
    </style><div class="window"><div class="plugin">[plugin:vite:vue]</div><pre class="message"><span class="message-body"></span></pre><div class="file"></div></div>`;
  }
}
customElements.define('vite-error-overlay', ErrorOverlay);

events.onmessage = async event => {
  const { mode, version } = JSON.parse(event.data);
  switch (mode) {
    case 'hmr':
    case '404': {
      // An update that compiles clears the error overlay, as Vite's client does.
      for (const overlay of document.querySelectorAll('vite-error-overlay')) overlay.remove();
      const mod = await import(`/src/app.js?t=${Date.now()}`);
      mod.render(panel, version);
      console.debug('[vite] hot updated: /src/app.js');
      if (mode === '404') fetch('/api/missing').catch(() => {});
      break;
    }
    case 'css':
      document.getElementById('theme').textContent = `#box { background: hsl(${(version * 67) % 360}, 70%, 45%); }`;
      break;
    case 'error': {
      const mod = await import(`/src/broken.js?t=${Date.now()}`);
      console.debug('[vite] hot updated: /src/broken.js');
      setTimeout(() => mod.render(panel));
      break;
    }
    case 'overlay': {
      const overlay = new ErrorOverlay();
      overlay.shadowRoot.querySelector('.message-body').textContent = 'src/components/Cart.vue: Unexpected token (31:18)';
      overlay.shadowRoot.querySelector('.file').textContent = '/src/components/Cart.vue:31:18';
      document.body.appendChild(overlay);
      break;
    }
    case 'reload':
      console.debug('[vite] page reload /app.html');
      location.reload();
      break;
    case 'navigate':
      location.href = '/app.html?page=2';
      break;
  }
};
