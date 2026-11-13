// Keeps what the user does in a tab handed to them (browser_request_user_input, see ../handoff.ts) away
// from agents once the tab is theirs again: the requests the page made meanwhile lose their URL query,
// headers and bodies (a login form post, a token request, an Authorization header), console messages
// logged meanwhile lose their text, and password and one-time-code fields still on the page are emptied.
//
// While the user has the tab it is paused, so no agent can read it at all; this runs before the pause
// ends. Entries still in flight are flagged `withheld`, so headers that arrive later are dropped too.
import type { NetworkEntry } from './networkLog';
import { withheldUrl } from './networkLog';
import type { PageState } from './pageState';

export const WITHHELD_MESSAGE = '(logged while the user had the tab; withheld)';

/** Withholds what the tab recorded after `seq`. Returns how many requests and console messages that was. */
export function withholdSince(state: PageState, seq: number): { requests: number; messages: number } {
  let requests = 0;
  const redirected = new Set<string>();
  for (const entry of state.network.entries.after(seq)) {
    withholdEntry(entry);
    redirected.add(entry.requestId);
    requests++;
  }
  // A request from before the hand-off that redirected into it (to the sign-in page, or back with a
  // code): the hop it redirected with belongs to the hand-off.
  for (const entry of state.network.entries.all()) {
    if (entry.seq > seq || !entry.redirectedTo || !redirected.has(entry.requestId)) continue;
    entry.redirectedTo = withheldUrl(entry.redirectedTo);
    entry.responseHeaders = undefined;
  }
  let messages = 0;
  for (const entry of state.console.entries.after(seq)) {
    entry.text = WITHHELD_MESSAGE;
    entry.location = undefined;
    messages++;
  }
  return { requests, messages };
}

export function withholdEntry(entry: NetworkEntry): void {
  entry.withheld = true;
  entry.url = withheldUrl(entry.url);
  if (entry.redirectedTo) entry.redirectedTo = withheldUrl(entry.redirectedTo);
  entry.requestHeaders = undefined;
  entry.responseHeaders = undefined;
  entry.postData = undefined;
}

/**
 * Empties password, current/new-password and one-time-code fields in a document, its same-origin
 * frames and open shadow roots, the way typing would (so frameworks that keep the value in state drop
 * it too). Evaluates to how many of them had a value.
 */
export const SCRUB_EXPRESSION = `(() => {
  const SEL = 'input[type=password i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i], input[autocomplete~="one-time-code" i]';
  let cleared = 0;
  const visit = (root, win) => {
    for (const el of root.querySelectorAll(SEL)) {
      if (el.value) {
        cleared++;
        try { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(el, ''); } catch { el.value = ''; }
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
      if (el.getAttribute('value')) el.setAttribute('value', '');
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot, win);
  };
  const walk = win => {
    try {
      visit(win.document, win);
      for (let i = 0; i < win.frames.length; i++) walk(win.frames[i]);
    } catch {
      // A cross-origin frame: its own target is scrubbed separately.
    }
  };
  walk(window);
  return cleared;
})()`;

/** Runs SCRUB_EXPRESSION in the page and in every cross-origin frame. Returns how many fields had a value. */
export async function scrubSecretFields(state: PageState): Promise<number> {
  const targets = [state.page, ...state.frames.list().map(f => f.session)];
  const counts = await Promise.all(
    targets.map(target =>
      target
        .send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: SCRUB_EXPRESSION, returnByValue: true }, { timeoutMs: 3000 })
        .then(r => (typeof r.result?.value === 'number' ? r.result.value : 0))
        .catch(() => 0),
    ),
  );
  return counts.reduce((a, b) => a + b, 0);
}
