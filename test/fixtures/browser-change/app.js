// A stand-in for a dev server's client (see server.mjs): listens for edits on /events and applies
// them the way Vite's client would, printing the same console lines.
//
// Query parameters make the page change on its own, as real pages do:
//   clock=<ms>     a clock in #clock, updated every <ms>
//   poll=<ms>      fetches /api/status?t=<now> every <ms> and writes the answer into #status
//   carousel=<ms>  5 slides; the "active" class moves to the next one every <ms>
//   ticker=<ms>    a news line whose text changes every <ms>
//   feed=<ms>      a feed that gets a new item every <ms>, which gets the class "seen" 300 ms later
//   slowcalls=<n>  calls /api/slow (fast, answering 200) n times at load
const panel = document.getElementById('panel');
const params = new URLSearchParams(location.search);

if (params.get('clock')) {
  const clock = document.getElementById('clock');
  setInterval(() => (clock.textContent = new Date().toISOString()), Number(params.get('clock')));
}
if (params.get('poll')) {
  const status = document.getElementById('status');
  setInterval(async () => {
    const r = await fetch(`/api/status?t=${Date.now()}`);
    status.textContent = `status ${(await r.json()).n}`;
  }, Number(params.get('poll')));
}

function box(id, top) {
  const el = document.createElement('div');
  el.id = id;
  el.setAttribute('style', `position: absolute; left: 600px; top: ${top}px; width: 160px; font: 13px sans-serif;`);
  document.body.appendChild(el);
  return el;
}
if (params.get('carousel')) {
  const track = box('carousel', 300);
  for (let i = 0; i < 5; i++) track.insertAdjacentHTML('beforeend', `<div class="slide${i === 0 ? ' active' : ''}">Slide ${i + 1}</div>`);
  let at = 0;
  setInterval(() => {
    track.children[at].classList.remove('active');
    at = (at + 1) % 5;
    track.children[at].classList.add('active');
  }, Number(params.get('carousel')));
}
if (params.get('ticker')) {
  const ticker = box('ticker', 420);
  let n = 0;
  ticker.textContent = 'News 0';
  setInterval(() => (ticker.textContent = `News ${++n}`), Number(params.get('ticker')));
}
if (params.get('feed')) {
  const feed = box('feed', 460);
  let n = 0;
  setInterval(() => {
    const item = document.createElement('p');
    item.textContent = `Item ${++n}`;
    feed.prepend(item);
    if (feed.children.length > 5) feed.lastElementChild.remove();
    setTimeout(() => item.classList.add('seen'), 300);
  }, Number(params.get('feed')));
}
for (let i = 1; i <= Number(params.get('slowcalls') ?? 0); i++) fetch(`/api/slow?ms=10&status=200&n=${i}`);

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

async function hotUpdate(version) {
  // An update that compiles clears the error overlay, as Vite's client does.
  for (const overlay of document.querySelectorAll('vite-error-overlay')) overlay.remove();
  const mod = await import(`/src/app.js?t=${Date.now()}`);
  mod.render(panel, version);
  console.debug('[vite] hot updated: /src/app.js');
}

events.onmessage = async event => {
  const { mode, version } = JSON.parse(event.data);
  switch (mode) {
    case 'hmr':
      await hotUpdate(version);
      break;
    case '404':
      await hotUpdate(version);
      fetch('/api/missing').catch(() => {});
      break;
    case 'late':
      // An error that comes a moment after the update, while a check may be taking its screenshot.
      await hotUpdate(version);
      setTimeout(() => console.error('late error after the update'), 900);
      break;
    case 'slowfail':
      // A request that fails only after the check has returned.
      await hotUpdate(version);
      fetch('/api/slow?ms=5000').catch(() => {});
      break;
    case 'slowpoll':
      // A third call of an endpoint the page called twice before; this one fails after 2 s.
      await hotUpdate(version);
      fetch('/api/slow?ms=2000&status=500&n=3').catch(() => {});
      break;
    case 'same':
      // What webpack-dev-server 5 prints for a rebuild that changed nothing.
      console.info('[webpack-dev-server] App updated. Recompiling...');
      setTimeout(() => console.info('[webpack-dev-server] Nothing changed.'), 100);
      break;
    case 'busy':
      // A real update whose render keeps the page busy for 4 s.
      await hotUpdate(version);
      setTimeout(() => {
        const end = Date.now() + 4000;
        while (Date.now() < end);
      });
      break;
    case 'stalereload': {
      // A script the page starts loading just before it reloads: the old document's request never ends.
      const script = document.createElement('script');
      script.src = '/api/slow?ms=8000&status=200&js=1';
      document.head.appendChild(script);
      setTimeout(() => location.reload(), 300);
      break;
    }
    case 'hang':
      // An update that blocks the page for 20 s.
      console.debug('[vite] hot updated: /src/app.js');
      setTimeout(() => {
        const end = Date.now() + 20_000;
        while (Date.now() < end);
      });
      break;
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
