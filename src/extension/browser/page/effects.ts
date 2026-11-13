// After an action: waits briefly for its consequences to land (a navigation to load, requests it
// started to finish) and describes them in a few lines, so the agent learns what its click or key
// press did without another call.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { formatConsoleEntry } from './consoleLog';
import { isFailure } from './networkLog';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';

export interface ActionMark {
  seq: number;
  loaderId: string | undefined;
  url: string;
  tabs: Set<string>;
}

export function markAction(call: PageCall): ActionMark {
  return { seq: call.state.seq, loaderId: call.state.loaderId, url: call.state.url, tabs: new Set(call.env.services.browser.listTabs().map(t => t.id)) };
}

/** Waits for the action's effects (bounded) and returns lines describing them. */
export async function settle(call: PageCall, mark: ActionMark, options: { navigationTimeoutMs?: number; quietMs?: number; expectNavigation?: boolean } = {}): Promise<string[]> {
  const { state } = call;
  if (call.page.closed) return [`The tab closed.`];
  const navigationStarted = () => state.navigationStartSeq > mark.seq || state.loaderId !== mark.loaderId;
  if (!state.dialog) {
    // Give the page a moment to react: a click on a link or a submit starts navigating right away.
    await state.waitFor(() => navigationStarted() || (options.expectNavigation && state.navigations.after(mark.seq).length > 0), {
      timeoutMs: options.quietMs ?? 150,
      signal: call.signal,
    });
  }
  if (!state.dialog && (navigationStarted() || options.expectNavigation)) {
    await state.waitFor(
      () => {
        if (state.loaderId !== mark.loaderId) return state.lifecycleOf().has('load') && !state.pendingNavigation;
        if (options.expectNavigation && state.navigations.after(mark.seq).length > 0) return true;
        // Started but not committed: wait, unless it ended without a new document (204, download, cancelled).
        return navigationStarted() && state.navigationEndSeq > state.navigationStartSeq && !state.loading;
      },
      { timeoutMs: options.navigationTimeoutMs ?? 10_000, signal: call.signal },
    );
  }
  if (!state.dialog) {
    // Requests the action started: wait a little for them to finish so failures can be reported.
    await state.waitFor(
      // A response whose status arrived counts as done (its body may never be read).
      () => state.network.entries.after(mark.seq).every(e => e.end !== undefined || e.failed !== undefined || e.status !== undefined || e.type === 'EventSource' || e.type === 'WebSocket'),
      { timeoutMs: 1500, signal: call.signal, pollMs: 100 },
    );
    // A single-page app usually updates the URL right after its fetch completes.
    if (state.network.entries.after(mark.seq).length > 0 && !state.dialog) await state.waitFor(() => false, { timeoutMs: 100, signal: call.signal });
  }
  return describeEffects(call, mark);
}

export async function describeEffects(call: PageCall, mark: ActionMark): Promise<string[]> {
  const { state } = call;
  const lines: string[] = [];

  const navs = state.navigations.after(mark.seq);
  const lastDocument = [...navs].reverse().find(n => !n.sameDocument);
  if (lastDocument || state.loaderId !== mark.loaderId) {
    const loaded = state.lifecycleOf().has('load');
    const doc = state.loaderId ? state.network.byRequestId(state.loaderId) : undefined;
    const status = doc?.status !== undefined && doc.status >= 400 ? ` (HTTP ${doc.status})` : '';
    const title = state.dialog ? undefined : await pageTitle(call);
    lines.push(`Navigated to ${clip(state.url, 300)}${title ? ` — "${clip(title, 120)}"` : ''}${status}${loaded ? '' : ' (still loading)'}.`);
  } else if (navs.length > 0 || state.url !== mark.url) {
    lines.push(`URL changed to ${clip(state.url, 300)} (same page, no reload).`);
  }

  if (state.dialog) {
    const d = state.dialog;
    lines.push(`It opened ${d.type === 'alert' ? 'an' : 'a'} ${d.type} dialog${d.message ? `: "${clip(d.message, 300)}"` : ''}. The page is blocked until you answer it with browser_handle_dialog.`);
  } else {
    for (const d of state.dialogs.after(mark.seq)) {
      if (!d.closed) continue;
      if (d.type === 'beforeunload') lines.push(`The page asked to confirm leaving it (beforeunload); this was ${d.closed.accepted ? 'confirmed' : 'refused'}.`);
      else lines.push(`A ${d.type} dialog${d.message ? ` ("${clip(d.message, 120)}")` : ''} opened and was ${d.closed.accepted ? 'accepted' : 'dismissed'}.`);
    }
  }

  // After a navigation, only what the new document logged and requested counts: messages and failed
  // requests of the page being left (aborted fetches, unload errors) say nothing about the new one.
  const committed = [...navs].reverse().find(n => !n.sameDocument && n.loaderId === state.loaderId);
  const consoleEntries = state.console.entries.after(committed ? committed.seq : mark.seq);
  // "Failed to load resource" duplicates the failed request reported below.
  const errors = consoleEntries.filter(e => e.level === 'error' && !(e.source === 'browser' && e.text.startsWith('Failed to load resource')));
  const warnings = consoleEntries.filter(e => e.level === 'warning');
  for (const e of errors.slice(0, 3)) lines.push(`Console: ${clip(formatConsoleEntry(e, { withLocation: false }).split('\n')[0]!, 300)}`);
  const extra = [errors.length > 3 ? `${errors.length - 3} more errors` : '', warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''].filter(Boolean);
  if (extra.length) lines.push(`Console also has ${extra.join(' and ')} (browser_console_messages shows them).`);

  const failures = state.network.entries
    .after(mark.seq)
    .filter(e => isFailure(e) && !(e.loaderId && e.requestId === e.loaderId && e.status !== undefined) && !(committed && e.loaderId !== undefined && e.loaderId !== state.loaderId));
  for (const f of failures.slice(0, 3)) lines.push(`Request failed: ${f.method} ${clip(f.url, 200)} → ${f.failed ?? `HTTP ${f.status}`} (${f.id}).`);
  if (failures.length > 3) lines.push(`${failures.length - 3} more requests failed (browser_network_requests with status "failed").`);

  const hooks = (call.env.hooks ?? []).filter(h => h.effectLines);
  if (hooks.length === 0) {
    for (const p of state.popups.after(mark.seq)) {
      if (p.kind === 'download') lines.push(`A download started: ${clip(p.url, 200)}.`);
    }
  }
  for (const hook of hooks) lines.push(...(await hook.effectLines!(call, mark.seq)));
  const newTabs = call.env.services.browser.listTabs().filter(t => !mark.tabs.has(t.id));
  for (const t of newTabs) lines.push(`A new tab opened: ${t.id} ${clip(t.url, 200)}. Your current tab is still ${call.tab.id}; pass tab: "${t.id}" to use the new one.`);
  if (newTabs.length === 0) {
    for (const p of state.popups.after(mark.seq)) if (p.kind === 'window') lines.push(`The page tried to open a window: ${clip(p.url, 200)}.`);
  }
  return lines;
}

export async function pageTitle(call: PageCall): Promise<string | undefined> {
  try {
    return await call.evaluate<string>('function () { return document.title; }', [], { timeoutMs: 2000 });
  } catch (err) {
    if (err instanceof ToolError && err.code === 'cancelled') throw err;
    if (err instanceof DialogInterrupt) return undefined;
    return undefined;
  }
}

/** Joins a one-line summary and effect lines into the tool result. */
export function report(summary: string, effects: string[]): string {
  return [summary, ...effects].join('\n');
}
