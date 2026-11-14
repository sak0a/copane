// Records what each agent session does in each tab, so browser_export_test can turn it into a
// Playwright test. One recording per (session, tab), kept in memory, started by the session's first
// action in the tab (or a reset) and dropped with the tab or the session.
//
// It sees tool calls through two seams: it wraps the handlers of the page tools it records (name,
// arguments, and whether the call succeeded: a call that fails leaves nothing behind), and it is a
// PageHook (call.ts) that is shown each call's PageCall and each element the call resolved. A locator
// for that element is chosen right then (locators.ts), while the element is still on the page, and
// checked to match only that element. Values typed into password, one-time-code and card fields are
// never stored: the step keeps the name of an environment variable instead.
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { Disposable } from '../../core/events';
import { ToolError } from '../../core/errors';
import type { BridgeServices } from '../../core/services';
import type { ToolContext, ToolDefinition } from '../../core/tools';
import type { PageCall, PageHook } from './call';
import { focusedAcrossFrames } from './frameQuery';
import { locateElement, locateSelector, locateText, type LocatedElement } from './locators';
import { normalizeUrl } from './navigationTools';
import { DEEP_ACTIVE_ELEMENT } from './scripts';
import type { ElementTarget } from './targets';
import { secretEnvName, type Step, type StepTarget, type Text } from './testCode';

/** Steps a recording keeps; older ones are dropped. */
const MAX_STEPS = 400;
/** Choosing a locator must never hold up an action for long. */
const LOCATE_TIMEOUT_MS = 3000;

export interface Recording {
  startUrl: string;
  startedAt: number;
  steps: Step[];
  dropped: number;
  /** URL after the last recorded step: a different one at the next step was a change the agent saw. */
  lastUrl: string;
  /** Secret fields seen so far: label → environment variable. */
  secrets: Map<string, string>;
}

const RECORDED = new Set([
  'browser_navigate', 'browser_history', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_hover', 'browser_scroll',
  'browser_drag', 'browser_upload_file', 'browser_handle_dialog', 'browser_wait_for', 'browser_evaluate', 'browser_emulate',
]);
/** Tools whose resolved elements become locators. */
const WITH_TARGETS = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_hover', 'browser_scroll', 'browser_drag', 'browser_upload_file']);
const ACTIONS = new Set<Step['kind']>(['click', 'fill', 'type', 'check', 'select', 'press', 'hover', 'scroll', 'drag', 'upload', 'goto', 'history']);

/** An element an action used: its locator, or why there is none. `secret` (the field's label) is known either way. */
type Located = (LocatedElement | { failed: string }) & { secretLabel?: string };

interface Pending {
  tool: string;
  args: any;
  ctx: ToolContext;
  call?: PageCall;
  urlBefore?: string;
  tabsBefore?: Set<string>;
  dialogType?: string;
  /** browser_type or browser_press_key without a target: the label of the focused field when it is a secret one. */
  focusedSecret?: string;
  targets: Located[];
}

/**
 * Element (this). The field's label when it is a secret field (password, one-time code, card number or
 * code), else ''. Cheap, and run before anything slow, so a secret is recognised even when choosing a
 * locator fails.
 */
const SECRET_FIELD = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return '';
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (!(el.type === 'password' || /(current|new)-password|one-time-code|cc-number|cc-csc/.test(ac))) return '';
  const label = el.labels && el.labels[0] ? el.labels[0].textContent : el.getAttribute('aria-label') || el.name || el.id || 'password';
  return String(label).replace(/\\s+/g, ' ').trim() || 'password';
}`;

/** Used as the label when whether a field is secret could not be found out: the value is then kept out. */
const UNKNOWN_SECRET = 'secret';

export class Recorder implements PageHook, Disposable {
  private readonly recordings = new Map<string, Recording>();
  private readonly pending = new WeakMap<ToolContext, Pending>();
  private readonly subscriptions: Disposable[];

  constructor(private readonly services: BridgeServices) {
    this.subscriptions = [
      services.browser.onDidChange(() => {
        const open = new Set(services.browser.listTabs().map(t => t.id));
        for (const key of [...this.recordings.keys()]) if (!open.has(key.split('\u0000')[1]!)) this.recordings.delete(key);
      }),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        for (const key of [...this.recordings.keys()]) if (key.startsWith(`${change.session.id}\u0000`)) this.recordings.delete(key);
      }),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.recordings.clear();
  }

  /** Wraps the handlers of the recorded tools; the others are returned unchanged. */
  instrument(tools: ToolDefinition<any>[]): ToolDefinition<any>[] {
    return tools.map(tool => {
      if (!RECORDED.has(tool.name)) return tool;
      const original = tool.handler;
      return {
        ...tool,
        handler: async (args: any, ctx: ToolContext) => {
          const p: Pending = { tool: tool.name, args, ctx, targets: [] };
          this.pending.set(ctx, p);
          try {
            const output = await original(args, ctx);
            await this.safely(() => this.commit(p));
            return output;
          } catch (err) {
            // browser_fill_form stops at the first field that fails; the ones before it were filled.
            const field = tool.name === 'browser_fill_form' && err instanceof ToolError ? /^Field (\d+) failed/.exec(err.message) : null;
            if (field) await this.safely(() => this.commit(p, Number(field[1]) - 1));
            throw err;
          } finally {
            this.pending.delete(ctx);
          }
        },
      };
    });
  }

  private async safely(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') return;
      this.services.log.warn('recording a step failed', err);
    }
  }

  // ------------------------------------------------------------------------------ PageHook

  observeCall(call: PageCall): void {
    const p = this.pending.get(call.ctx);
    if (!p || p.call) return;
    p.call = call;
    p.urlBefore = call.state.url;
    p.dialogType = call.state.dialog?.type;
    p.tabsBefore = new Set(this.services.browser.listTabs().map(t => t.id));
    // The URL changed since the agent's last step without a step of its own (a redirect after a login,
    // a timer, a link the agent followed in a snapshot it took meanwhile): the agent saw it, so assert it.
    const rec = this.recordings.get(call.sessionTabKey);
    if (rec && !isBlank(call.state.url) && call.state.url !== rec.lastUrl && p.tool !== 'browser_navigate') {
      this.push(rec, { kind: 'expectUrl', url: call.state.url });
      rec.lastUrl = call.state.url;
    }
  }

  async aroundControl(call: PageCall): Promise<undefined> {
    const p = this.pending.get(call.ctx);
    if ((p?.tool === 'browser_type' || p?.tool === 'browser_press_key') && p.args.ref === undefined && p.args.selector === undefined) {
      // Typing into whatever has focus, followed into shadow roots and frames (cross-origin ones too).
      try {
        const focused = await focusedAcrossFrames(call, DEEP_ACTIVE_ELEMENT);
        p.focusedSecret = focused ? (await focused.at.callOn<string>(focused.objectId, SECRET_FIELD, [], { timeoutMs: 2000 })) || undefined : undefined;
      } catch (err) {
        if (err instanceof ToolError && err.code === 'cancelled') throw err;
        p.focusedSecret = UNKNOWN_SECRET;
      }
    }
    return undefined;
  }

  async targetResolved(call: PageCall, target: ElementTarget): Promise<void> {
    const p = this.pending.get(call.ctx);
    if (!p || !WITH_TARGETS.has(p.tool)) return;
    const slot = p.targets.length;
    let secretLabel: string | undefined;
    try {
      secretLabel = (await target.call.callOn<string>(target.objectId, SECRET_FIELD, [], { timeoutMs: 2000 })) || undefined;
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      secretLabel = UNKNOWN_SECRET;
    }
    p.targets.push({ failed: target.label, ...(secretLabel ? { secretLabel } : {}) });
    let timer: NodeJS.Timeout | undefined;
    try {
      const located = await Promise.race([
        locateElement(call, target),
        new Promise<undefined>(resolve => (timer = setTimeout(() => resolve(undefined), LOCATE_TIMEOUT_MS))),
      ]);
      if (located) p.targets[slot] = { ...located, ...(secretLabel ? { secretLabel } : {}) };
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      this.services.log.warn(`choosing a locator for ${target.label} failed`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs a lookup on the page after the tool's call ended (its object group is released again afterwards). */
  private async inFrames(call: PageCall, lookup: () => Promise<string[] | undefined>): Promise<{ frames?: string[] }> {
    if (call.page.closed || call.state.dialog) return {};
    try {
      const frames = await lookup();
      return frames ? { frames } : {};
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      return {};
    } finally {
      call.dispose();
    }
  }

  // ------------------------------------------------------------------------------ recordings

  get(sessionId: string, tabId: string): Recording | undefined {
    return this.recordings.get(`${sessionId}\u0000${tabId}`);
  }

  /** Starts a new, empty recording from the page the tab shows now. */
  reset(sessionId: string, tabId: string, url: string): void {
    this.recordings.set(`${sessionId}\u0000${tabId}`, { startUrl: url, startedAt: Date.now(), steps: [], dropped: 0, lastUrl: url, secrets: new Map() });
  }

  private push(rec: Recording, ...steps: Step[]): void {
    rec.steps.push(...steps);
    const over = rec.steps.length - MAX_STEPS;
    if (over > 0) {
      rec.steps.splice(0, over);
      rec.dropped += over;
    }
  }

  private target(p: Pending, index: number): StepTarget {
    const t = p.targets[index];
    if (!t || 'failed' in t) return { locator: { frames: [], parts: [{ kind: 'css', selector: 'UNKNOWN' }] }, robust: false, label: t ? `${t.failed}: no locator could be worked out` : 'an element' };
    return { locator: t.chain, robust: t.robust, label: t.label };
  }

  private secret(rec: Recording, label: string): Text {
    const key = label.toLowerCase();
    let env = rec.secrets.get(key);
    if (!env) rec.secrets.set(key, (env = secretEnvName(label, new Set(rec.secrets.values()))));
    return { env };
  }

  /** The value to record for text typed into an element: an environment variable for a secret field. */
  private textFor(rec: Recording, located: Located | undefined, value: string): Text {
    if (!located) return this.secret(rec, UNKNOWN_SECRET);
    const label = located.secretLabel ?? (!('failed' in located) && located.secret ? located.labelText : undefined);
    return label ? this.secret(rec, label) : value;
  }

  /** Turns a finished call into steps. `fields` limits browser_fill_form to the fields that were filled. */
  private async commit(p: Pending, fields?: number): Promise<void> {
    const call = p.call;
    if (!call) return;
    const key = call.sessionTabKey;
    let rec = this.recordings.get(key);
    if (!rec) {
      this.reset(call.ctx.session.id, call.tab.id, p.urlBefore ?? call.state.url);
      rec = this.recordings.get(key)!;
    }
    const a = p.args;
    const steps: Step[] = [];
    const point = (x: number | undefined, y: number | undefined): StepTarget => ({ point: { x: x ?? 0, y: y ?? 0 }, label: `(${Math.round(x ?? 0)}, ${Math.round(y ?? 0)})` });
    let next = 0;
    const element = (): StepTarget => this.target(p, next++);
    const urlNow = call.state.url;
    let assertUrl = true;
    switch (p.tool) {
      case 'browser_navigate': {
        const url = normalizeUrl(a.url);
        steps.push({ kind: 'goto', url });
        assertUrl = urlNow !== url && urlNow !== `${url}/`;
        break;
      }
      case 'browser_history':
        steps.push({ kind: 'history', action: a.action });
        assertUrl = a.action !== 'reload';
        break;
      case 'browser_click':
        steps.push({
          kind: 'click',
          target: a.ref !== undefined || a.selector !== undefined ? element() : point(a.x, a.y),
          ...(a.button && a.button !== 'left' ? { button: a.button } : {}),
          ...(a.doubleClick ? { double: true } : {}),
          ...(a.modifiers?.length ? { modifiers: a.modifiers } : {}),
        });
        break;
      case 'browser_type': {
        const hasTarget = a.ref !== undefined || a.selector !== undefined;
        const located = hasTarget ? p.targets[0] : undefined;
        const value = hasTarget ? this.textFor(rec, located, a.text) : p.focusedSecret ? this.secret(rec, p.focusedSecret) : a.text;
        steps.push({ kind: 'type', ...(hasTarget ? { target: element() } : {}), value, ...(a.clear === false ? { append: true } : {}), ...(a.slowly ? { slowly: true } : {}), ...(a.submit ? { submit: true } : {}) } as Step);
        break;
      }
      case 'browser_fill_form': {
        const count = Math.min(fields ?? a.fields.length, a.fields.length, p.targets.length);
        for (let i = 0; i < count; i++) {
          const f = a.fields[i];
          const located = p.targets[i];
          const target = element();
          if (typeof f.value === 'boolean') steps.push({ kind: 'check', target, checked: f.value });
          else if (Array.isArray(f.value)) steps.push({ kind: 'select', target, values: f.value });
          else if (located && !('failed' in located) && located.tag === 'select') steps.push({ kind: 'select', target, values: [f.value] });
          else steps.push({ kind: 'fill', target, value: this.textFor(rec, located, f.value) });
        }
        break;
      }
      case 'browser_press_key': {
        const hasTarget = a.ref !== undefined || a.selector !== undefined;
        const located = hasTarget ? p.targets[0] : undefined;
        const secretField = hasTarget ? !located || !!located.secretLabel || (!('failed' in located) && located.secret) : !!p.focusedSecret;
        // A character pressed into a secret field is part of the secret.
        const key = String(a.key).split('+').pop() ?? '';
        if (secretField && [...key].length === 1 && !/^(Control|Meta|Alt|ControlOrMeta)\+/i.test(a.key)) {
          steps.push({ kind: 'note', text: 'Left out: a key pressed in a secret field.' });
          if (hasTarget) next++;
        } else steps.push({ kind: 'press', ...(hasTarget ? { target: element() } : {}), key: a.key, count: a.count ?? 1 });
        break;
      }
      case 'browser_hover':
        steps.push({ kind: 'hover', target: a.ref !== undefined || a.selector !== undefined ? element() : point(a.x, a.y) });
        break;
      case 'browser_scroll': {
        const target = a.ref !== undefined || a.selector !== undefined ? element() : undefined;
        if (!a.direction && !a.to) steps.push({ kind: 'scroll', target, dx: 0, dy: 0 });
        else {
          const amount = a.to ? 100_000 : (a.amount ?? 600);
          const dir = a.to ?? a.direction;
          const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
          const dy = dir === 'up' || dir === 'top' ? -amount : dir === 'down' || dir === 'bottom' ? amount : 0;
          steps.push({ kind: 'scroll', target, dx, dy });
        }
        break;
      }
      case 'browser_drag': {
        const from = a.fromRef !== undefined || a.fromSelector !== undefined ? element() : point(a.fromX, a.fromY);
        const to = a.toRef !== undefined || a.toSelector !== undefined ? element() : point(a.toX, a.toY);
        steps.push({ kind: 'drag', from, to });
        break;
      }
      case 'browser_upload_file': {
        const located = p.targets[0];
        const base = p.ctx.session.cwd ?? this.services.window.workspaceFolders[0] ?? process.cwd();
        const files = (a.paths as string[]).map(f => {
          const full = isAbsolute(f) ? f : resolvePath(base, f);
          const rel = relative(base, full);
          return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : full;
        });
        steps.push({ kind: 'upload', target: element(), files, chooser: !(located && !('failed' in located) && located.fileInput) });
        break;
      }
      case 'browser_handle_dialog': {
        if (p.dialogType === 'beforeunload') return;
        // Playwright needs the answer before the action that opens the dialog.
        const step: Step = { kind: 'dialog', accept: a.accept, ...(a.accept && p.dialogType === 'prompt' && a.promptText !== undefined ? { promptText: a.promptText } : {}) };
        let at = rec.steps.length;
        while (at > 0 && !ACTIONS.has(rec.steps[at - 1]!.kind)) at--;
        rec.steps.splice(Math.max(0, at - 1), 0, step);
        rec.lastUrl = urlNow;
        return;
      }
      case 'browser_wait_for':
        if (a.url !== undefined) {
          steps.push({ kind: 'expectUrlPattern', pattern: a.url });
          assertUrl = false;
        }
        // browser_wait_for looks into iframes, Playwright's page.getByText does not: say which frame.
        if (a.text !== undefined) steps.push({ kind: 'expectText', text: a.text, ...(await this.inFrames(call, () => locateText(call, a.text))) });
        if (a.textGone !== undefined) steps.push({ kind: 'expectText', text: a.textGone, gone: true });
        if (a.selector !== undefined) {
          const look = (a.state ?? 'visible') === 'visible' || a.state === 'attached';
          steps.push({ kind: 'expectSelector', selector: a.selector, state: a.state ?? 'visible', ...(look ? await this.inFrames(call, () => locateSelector(call, a.selector)) : {}) });
        }
        if (a.loadState !== undefined) steps.push({ kind: 'waitLoad', state: a.loadState });
        if (steps.length === 0 && a.time !== undefined) steps.push({ kind: 'waitTime', ms: a.time * 1000 });
        // A URL that changed while waiting comes before what was waited for.
        if (assertUrl && !isBlank(urlNow) && urlNow !== rec.lastUrl) steps.unshift({ kind: 'expectUrl', url: urlNow });
        assertUrl = false;
        break;
      case 'browser_evaluate':
        // Not quoted: a script may carry a token or other secret.
        steps.push({ kind: 'note', text: 'Left out: a script ran here (browser_evaluate); if the flow depends on what it did, add it as page.evaluate().' });
        break;
      case 'browser_emulate':
        steps.push({ kind: 'note', text: 'Left out: browser_emulate changed the device or media here; set the same in test.use() or playwright.config.' });
        assertUrl = false;
        break;
    }
    if (assertUrl && !isBlank(urlNow) && urlNow !== (p.tool === 'browser_navigate' ? normalizeUrl(a.url) : p.urlBefore)) steps.push({ kind: 'expectUrl', url: urlNow });
    const opened = this.services.browser.listTabs().filter(t => p.tabsBefore && !p.tabsBefore.has(t.id) && t.openerTab === call.tab.id);
    for (const t of opened) steps.push({ kind: 'note', text: `Left out: this opened a new tab (${t.id}); in the test, wait for it with page.waitForEvent('popup') before the step above. Its own steps are in that tab's recording.` });
    this.push(rec, ...steps);
    rec.lastUrl = urlNow;
  }
}

function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}
