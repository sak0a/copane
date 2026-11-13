// The in-page indicator: while an agent session controls a tab, the page shows a thin frame and a small
// pill in the session's color ("Claude 2 · checkout tests  [Take over]"); while the user has paused the
// tab, the pill offers "Resume".
//
// Isolation: the script runs in a CDP isolated world (`WORLD`), so page scripts can neither see its
// globals nor call the binding it reports clicks through. It draws inside a closed shadow root, styles
// itself through CSSOM and a constructed stylesheet (allowed under strict CSP and Trusted Types), puts
// itself back when the page removes it, and acts only on trusted (real or CDP) clicks. It is installed
// with `Page.addScriptToEvaluateOnNewDocument`, so it survives navigations and reloads.
//
// Contract with the page tools: every node the bridge injects into a page carries `data-agent-bridge-ui`
// on its outermost element. Their snapshots skip it, their screenshots hide it (an author `!important`
// rule or inline style on that element works: the indicator never sets display, visibility or opacity
// on it as important). The indicator itself also turns click-through while an agent sends input, so an
// agent click on whatever lies under it reaches the page.
//
// No `vscode` dependency: it only needs `send` and `on` of a CDP page.

export const MARKER_ATTRIBUTE = 'data-agent-bridge-ui';
export const WORLD = '__agentBridge';
export const BINDING = '__agentBridgeUi';

export interface MarkerState {
  /** "Claude 2 · checkout tests" */
  label: string;
  /** CSS color of the session. */
  color: string;
  /** The user paused agent access: the pill offers "Resume". */
  paused: boolean;
}

export type MarkerAction = 'pause' | 'resume';

/** The CDP surface the marker needs; `CdpPage` satisfies it. */
export interface MarkerPage {
  send<T = any>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  on(event: string, listener: (params: any) => void): { dispose(): void };
}

// The page script below runs in the page, not in Node; these stand in for the DOM types this project
// does not compile against.
declare const window: any;
declare const document: any;
declare const MutationObserver: any;
declare const CSSStyleSheet: any;
type HTMLElement = any;

// Runs in the page, in the isolated world. Self-contained: it is stringified.
function pageScript(BINDING: string, ATTRIBUTE: string): void {
  if (window.top !== window) return;
  const g = globalThis as any;
  if (g.__agentBridgeMarker) {
    g.__agentBridgeMarker.hello();
    return;
  }
  const send = (message: unknown) => {
    try {
      g[BINDING](JSON.stringify(message));
    } catch {
      // Binding not available (yet): nothing to report to.
    }
  };
  const CSS = `
    :host { all: initial; }
    .root { --c: #3794ff; }
    .frame { position: fixed; inset: 0; box-sizing: border-box; border: 2px solid var(--c); opacity: .6; pointer-events: none; }
    .pill { position: fixed; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 6px; box-sizing: border-box;
      max-width: min(380px, calc(100vw - 20px)); padding: 3px 3px 3px 9px; border-radius: 999px; border: 1px solid var(--c);
      background: rgba(30, 30, 32, .92); color: #f3f3f3; font: 500 12px/18px system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: normal; text-align: left; box-shadow: 0 2px 10px rgba(0, 0, 0, .28); pointer-events: auto; user-select: none;
      cursor: default; transition: opacity .12s; direction: ltr; }
    .left .pill { right: auto; left: 10px; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
    .label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
    button { all: unset; flex: none; cursor: pointer; padding: 0 8px; border-radius: 999px; background: rgba(255, 255, 255, .14);
      font: inherit; color: inherit; line-height: 18px; }
    button:hover { background: rgba(255, 255, 255, .28); }
    button:focus-visible { outline: 2px solid var(--c); outline-offset: 1px; }
    .passive .pill { pointer-events: none; opacity: .45; }
    .paused .frame { display: none; }
    .paused .dot { background: transparent; border: 2px solid var(--c); width: 4px; height: 8px; border-radius: 0; border-top: 0; border-bottom: 0; }
  `;
  let state: { label: string; color: string; paused: boolean } | null = null;
  let host: HTMLElement | undefined;
  let root: HTMLElement | undefined;
  let label: HTMLElement | undefined;
  let button: HTMLElement | undefined;
  let passiveTimer: any;
  let left = false;
  let reattachBudget = 50;
  let budgetTimer: any;

  const important = (el: HTMLElement, props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
  };

  function build(): void {
    host = document.createElement('div');
    host.setAttribute(ATTRIBUTE, '');
    // Position and stacking are important so page CSS cannot move it; display, visibility and opacity
    // are not, so the page tools can hide it for screenshots.
    important(host, {
      position: 'fixed', inset: '0', width: 'auto', height: 'auto', margin: '0', padding: '0', border: '0', background: 'transparent',
      'pointer-events': 'none', 'z-index': '2147483647', transform: 'none', filter: 'none', 'clip-path': 'none', 'max-width': 'none', 'max-height': 'none',
    });
    host.style.setProperty('display', 'block');
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    root = document.createElement('div');
    root.className = 'root';
    const frame = document.createElement('div');
    frame.className = 'frame';
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dot';
    label = document.createElement('span');
    label.className = 'label';
    label.title = 'Move to the other corner';
    button = document.createElement('button');
    button.setAttribute('type', 'button');
    pill.append(dot, label, button);
    root.append(frame, pill);
    shadow.appendChild(root);
    label.addEventListener('click', (event: any) => {
      if (!event.isTrusted) return;
      left = !left;
      render();
    });
    button.addEventListener('click', (event: any) => {
      if (!event.isTrusted || !state) return;
      event.stopPropagation();
      send({ type: state.paused ? 'resume' : 'pause' });
    });
    // Keep page handlers from seeing interaction with the indicator.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup']) {
      pill.addEventListener(type, (event: any) => event.stopPropagation());
    }
  }

  let removals = 0;
  const observer = new MutationObserver(() => {
    if (!state || !host || host.isConnected) return;
    removals++;
    if (reattachBudget-- <= 0) return; // The page keeps removing it; give up rather than fight.
    budgetTimer ??= setTimeout(() => {
      reattachBudget = 50;
      budgetTimer = undefined;
    }, 10_000);
    attach();
  });

  function attach(): void {
    if (!host) return;
    // Under <html>, out of the way of frameworks that own <body>; under <body> if the page keeps
    // removing foreign children of <html>.
    const parent = removals > 2 && document.body ? document.body : document.documentElement;
    if (!parent) return;
    if (host.parentNode !== parent) parent.appendChild(host);
    observer.observe(document, { childList: true });
    observer.observe(document.documentElement, { childList: true });
    if (parent !== document.documentElement) observer.observe(parent, { childList: true });
  }

  function render(): void {
    if (!state) {
      observer.disconnect();
      host?.remove();
      return;
    }
    if (!host) build();
    root!.style.setProperty('--c', state.color);
    root!.className = `root${state.paused ? ' paused' : ''}${left ? ' left' : ''}${passiveTimer ? ' passive' : ''}`;
    label!.textContent = state.paused ? 'Agent access paused' : state.label;
    button!.textContent = state.paused ? 'Resume' : 'Take over';
    button!.title = state.paused ? `Let ${state.label} use this tab again` : `Pause ${state.label}: agents cannot use this tab until you resume`;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, { once: true });
    else attach();
  }

  g.__agentBridgeMarker = {
    set(next: typeof state) {
      state = next;
      render();
    },
    /** An agent is about to send input: let it pass through the indicator for a moment. */
    passive(ms: number) {
      clearTimeout(passiveTimer);
      passiveTimer = setTimeout(() => {
        passiveTimer = undefined;
        if (state) render();
      }, ms);
      if (state) render();
    },
    hello() {
      send({ type: 'hello' });
    },
  };
  send({ type: 'hello' });
}

/** The source installed in every new document of the tab. */
export function markerSource(): string {
  return `(${pageScript.toString()})(${JSON.stringify(BINDING)}, ${JSON.stringify(MARKER_ATTRIBUTE)});`;
}

const PASSIVE_MS = 1500;

/** Keeps one tab's indicator in sync with `set` and reports the user's clicks on it. */
export class PageMarker {
  private contextId: number | undefined;
  private state: MarkerState | null = null;
  private passiveUntil = 0;
  private installing: Promise<void> | undefined;
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private disposed = false;

  constructor(
    private readonly page: MarkerPage,
    private readonly onAction: (action: MarkerAction) => void,
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Installs the script for future documents and the current one. Safe to call more than once. */
  install(): Promise<void> {
    this.installing ??= this.doInstall().catch(err => {
      this.installing = undefined;
      this.log(`page indicator could not be installed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.installing;
  }

  /** Shows (or with null removes) the indicator. */
  set(state: MarkerState | null): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    if (state) void this.install();
    void this.push();
  }

  get current(): MarkerState | null {
    return this.state;
  }

  /** Call before an agent's input event reaches the page, so the indicator does not catch the click. */
  async beforeInput(): Promise<void> {
    if (!this.state || this.state.paused || this.disposed) return;
    const now = this.now();
    if (now < this.passiveUntil - 500) return;
    this.passiveUntil = now + PASSIVE_MS;
    await this.evaluate(`globalThis.__agentBridgeMarker?.passive(${PASSIVE_MS})`, 300);
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }

  private async doInstall(): Promise<void> {
    this.subscriptions.push(
      this.page.on('Runtime.bindingCalled', params => {
        if (params?.name !== BINDING) return;
        let message: { type?: string } | undefined;
        try {
          message = JSON.parse(params.payload);
        } catch {
          return;
        }
        if (message?.type === 'hello') {
          this.contextId = params.executionContextId;
          if (this.state) void this.push();
        } else if (message?.type === 'pause' || message?.type === 'resume') {
          this.onAction(message.type);
        }
      }),
    );
    await this.page.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    // Binding calls are only reported while the Runtime domain is enabled.
    await this.page.send('Runtime.enable');
    const source = markerSource();
    await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD });
    // The document that is already loaded: create the world now and run the script there once.
    const contextId = await this.worldContext();
    if (contextId !== undefined) {
      this.contextId = contextId;
      await this.page.send('Runtime.evaluate', { expression: source, contextId });
    }
  }

  private async worldContext(): Promise<number | undefined> {
    const { frameTree } = await this.page.send('Page.getFrameTree');
    const frameId = frameTree?.frame?.id;
    if (!frameId) return undefined;
    const { executionContextId } = await this.page.send('Page.createIsolatedWorld', { frameId, worldName: WORLD });
    return executionContextId;
  }

  private async push(): Promise<void> {
    if (this.disposed) return;
    if (this.installing) await this.installing;
    await this.evaluate(`globalThis.__agentBridgeMarker?.set(${JSON.stringify(this.state)})`);
  }

  private async evaluate(expression: string, timeoutMs = 5000): Promise<void> {
    if (this.contextId === undefined || this.disposed) return;
    try {
      await this.page.send('Runtime.evaluate', { expression, contextId: this.contextId }, { timeoutMs });
    } catch {
      // The document went away; the next one says hello and gets the state then.
    }
  }
}
