// Showing the bridge's own page UI (the indicator with Take over, Resume, Done) again after a tool hid
// it for a screenshot. Kept apart from the call that hid it on purpose.
import type { PageCall } from './call';
import { TOGGLE_BRIDGE_UI } from './scripts';

/**
 * Shows the bridge's page UI again. Sent straight to the tab, not through the call: a cancelled call
 * refuses every command, and the indicator must never stay hidden. While a dialog blocks the page, it
 * is shown again once the dialog is gone.
 */
export function showBridgeUi(call: PageCall): void {
  const { state } = call;
  const send = async () => {
    try {
      const contextId = await state.isolatedWorld();
      await state.page.send('Runtime.callFunctionOn', { functionDeclaration: TOGGLE_BRIDGE_UI, executionContextId: contextId, arguments: [{ value: false }], returnByValue: true }, { timeoutMs: 5000 });
    } catch (err) {
      call.ctx.log.warn(`could not show the page indicator of ${call.tab.id} again`, err);
    }
  };
  if (state.page.closed) return;
  if (!state.dialog) {
    void send();
    return;
  }
  const sub = state.onDidChange(() => {
    if (state.dialog) return;
    sub.dispose();
    clearTimeout(timer);
    void send();
  });
  const timer = setTimeout(() => {
    sub.dispose();
    call.ctx.log.warn(`the page indicator of ${call.tab.id} stays hidden: a dialog was still open after 2 minutes`);
  }, 120_000);
}
