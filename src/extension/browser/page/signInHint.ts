// After an action that loaded a new page: if the page looks like a sign-in page (a visible password
// field, an identity provider, a login path), the action result says to hand the tab to the user
// (browser_request_user_input) instead of signing in. Once per page and session; one cheap evaluate,
// only after navigations. In full the first time in a session, short afterwards (sessionNotices.ts).
import { ToolError } from '../../core/errors';
import { SIGN_IN_HINT, SIGN_IN_HINT_SHORT, looksLikeSignIn } from '../handoffLogic';
import type { PageCall, PageHook } from './call';
import { DialogInterrupt } from './pageState';

const VISIBLE_PASSWORDS = `function () {
  return [...document.querySelectorAll('input[type=password i]')].filter(e => {
    const b = e.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.right > 0 && b.bottom > 0 && getComputedStyle(e).visibility !== 'hidden';
  }).length;
}`;

export class SignInHint implements PageHook {
  /** Per `${sessionId}\0${tabId}`: the document (loader id) it was last told about. */
  private readonly told = new Map<string, string>();

  async effectLines(call: PageCall, sinceSeq: number): Promise<string[]> {
    const { state } = call;
    // sinceSeq 0: a tab just opened (browser_open), whose first navigation may predate recording.
    const navigated = sinceSeq === 0 || state.navigations.after(sinceSeq).some(n => !n.sameDocument);
    const loaderId = state.loaderId;
    if (!navigated || !loaderId || state.dialog || this.told.get(call.sessionTabKey) === loaderId) return [];
    let passwords = 0;
    try {
      passwords = Number(await call.evaluate<number>(VISIBLE_PASSWORDS, [], { timeoutMs: 1500 })) || 0;
    } catch (err) {
      if (err instanceof DialogInterrupt) return [];
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
    }
    if (!looksLikeSignIn(state.url, passwords)) return [];
    this.told.set(call.sessionTabKey, loaderId);
    if (this.told.size > 500) this.told.delete(this.told.keys().next().value!);
    return [call.env.notices.pick(call.ctx.session.id, 'sign-in', SIGN_IN_HINT, SIGN_IN_HINT_SHORT)];
  }
}
