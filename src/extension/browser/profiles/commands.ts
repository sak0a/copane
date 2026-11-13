// The user's side of login profiles: open a tab in a profile (sign in there once, then agent sessions
// work in it), choose the profile of an agent session (Sessions view), close a profile. These are the
// user's own actions, so they use quick picks directly. Each command also takes its choices as
// arguments, which skips the pickers (scripts and tests: `debug_vscode_command`).
import * as vscode from 'vscode';
import type { BridgeServices } from '../../core/services';
import { sessionDisplayName } from '../../core/sessions';
import type { BrowserServiceImpl } from '../service';
import { normalizeUrl } from '../tabTools';
import type { ProfileManager } from './manager';
import { DEFAULT_PROFILE, isPrivate, LIFETIME, LOST, parseProfileName, privateKey } from './model';

type Pick = vscode.QuickPickItem & { key?: string; action?: 'new' | 'clear' };

export function registerProfileCommands(services: BridgeServices, browser: BrowserServiceImpl, profiles: ProfileManager): vscode.Disposable[] {
  const { sessions } = services;
  const status = (text: string) => vscode.window.setStatusBarMessage(text, 15_000);

  const describe = (p: ReturnType<ProfileManager['list']>[number]): string =>
    p.alive
      ? p.tabIds.length
        ? `${p.tabIds.length} tab${p.tabIds.length === 1 ? '' : 's'}`
        : p.keptWithoutTabs
          ? 'no tab open, logins kept'
          : 'no tab open'
      : p.lost
        ? `logins lost: ${LOST[p.lost]}`
        : 'starts logged out';

  const askNewName = async (): Promise<string | undefined> => {
    const value = await vscode.window.showInputBox({
      title: 'New Login Profile',
      prompt: 'A name for the profile, e.g. "dev", "test", "prod". Tabs of one profile share their logins; other tabs do not.',
      placeHolder: 'dev',
      validateInput: v => {
        if (!v.trim()) return undefined;
        const parsed = parseProfileName(v);
        if (!parsed.ok) return parsed.message;
        return parsed.key === DEFAULT_PROFILE ? '"default" is the shared store; pick another name.' : undefined;
      },
    });
    if (!value?.trim()) return undefined;
    const parsed = parseProfileName(value);
    return parsed.ok ? parsed.key : undefined;
  };

  /** Quick pick of profiles. Returns a profile key, DEFAULT_PROFILE, or 'clear'. */
  const pickProfile = async (options: { title: string; sessionId?: string; allowClear?: boolean; includeDefault?: boolean }): Promise<string | undefined> => {
    const items: Pick[] = [];
    for (const p of profiles.list()) {
      if (isPrivate(p.key) && p.key !== (options.sessionId && privateKey(options.sessionId))) continue;
      items.push({ label: `$(account) ${p.label}`, description: describe(p), key: p.key });
    }
    if (options.sessionId && !items.some(i => i.key === privateKey(options.sessionId!))) {
      items.push({ label: '$(lock) Private Profile of This Session', description: 'starts logged out; no other tab shares it', key: privateKey(options.sessionId) });
    }
    items.push({ label: '$(add) New Profile…', action: 'new' });
    if (options.includeDefault !== false) items.push({ label: '$(globe) Default Store', description: 'the logins every tab without a profile shares', key: DEFAULT_PROFILE });
    if (options.allowClear) items.push({ label: '$(clear-all) Clear', description: "back to the agent's own choice or the setting", action: 'clear' });
    const picked = await vscode.window.showQuickPick(items, { title: options.title, placeHolder: LIFETIME, matchOnDescription: true });
    if (!picked) return undefined;
    if (picked.action === 'new') return askNewName();
    if (picked.action === 'clear') return 'clear';
    return picked.key;
  };

  const sessionIdOf = (arg: unknown): string | undefined => {
    if (typeof arg === 'string' && sessions.get(arg)) return arg;
    if (arg && typeof arg === 'object') {
      const id = (arg as { id?: unknown; sessionId?: unknown }).sessionId ?? (arg as { id?: unknown }).id;
      if (typeof id === 'string') {
        const m = /^session:(.*?)(#empty)?$/.exec(id);
        const sessionId = m ? m[1]! : id;
        if (sessions.get(sessionId)) return sessionId;
      }
    }
    return undefined;
  };

  return [
    vscode.commands.registerCommand('copane.browser.openInProfile', async (profileArg?: unknown, urlArg?: unknown) => {
      browser.assertAvailable();
      let key: string | undefined;
      if (typeof profileArg === 'string' && profileArg.trim()) {
        const parsed = parseProfileName(profileArg);
        if (!parsed.ok) return void vscode.window.showWarningMessage(parsed.message);
        key = parsed.key;
      } else {
        key = await pickProfile({ title: 'Open Browser Tab in Login Profile' });
      }
      if (!key || key === 'clear') return;
      let url = typeof urlArg === 'string' && urlArg.trim() ? urlArg.trim() : undefined;
      url ??= await vscode.window.showInputBox({
        title: key === DEFAULT_PROFILE ? 'Open Browser Tab' : `Open Browser Tab in "${profiles.label(key)}"`,
        prompt: 'The address to open; sign in there once and every tab of this profile shares the login.',
        value: 'https://',
        valueSelection: [8, 8],
      });
      if (!url?.trim()) return;
      url = normalizeUrl(url);
      if (key === DEFAULT_PROFILE) {
        await vscode.window.openBrowserTab(url, { preserveFocus: false });
        return;
      }
      const opened = await profiles.open(key, url);
      const label = profiles.label(key);
      status(
        opened.lost
          ? `$(account) "${label}" starts logged out again: ${LOST[opened.lost]}.`
          : opened.fresh
            ? `$(account) New login profile "${label}": sign in in this tab. Logins last until VS Code quits, in memory only.`
            : `$(account) Opened in login profile "${label}".`,
      );
    }),

    vscode.commands.registerCommand('copane.browser.setSessionProfile', async (sessionArg?: unknown, profileArg?: unknown) => {
      let sessionId = sessionIdOf(sessionArg);
      if (!sessionId) {
        const live = sessions.list();
        if (!live.length) return void vscode.window.setStatusBarMessage('No agent session is connected to this window.', 5000);
        const picked = await vscode.window.showQuickPick(
          live.map(s => ({ label: sessionDisplayName(s), description: profiles.sessionProfile(s.id)?.label, id: s.id })),
          { title: 'Set Login Profile for Agent Session', placeHolder: 'Which session?' },
        );
        sessionId = picked?.id;
      }
      if (!sessionId) return;
      const session = sessions.get(sessionId)!;
      let key: string | undefined;
      if (typeof profileArg === 'string') {
        if (profileArg.trim() === '') key = 'clear';
        else {
          const parsed = parseProfileName(profileArg, sessionId);
          if (!parsed.ok) return void vscode.window.showWarningMessage(parsed.message);
          key = parsed.key;
        }
      } else {
        key = await pickProfile({ title: `Login Profile for ${sessionDisplayName(session)}'s New Tabs`, sessionId, allowClear: true });
      }
      if (!key) return;
      profiles.setDefault(sessionId, key === 'clear' ? undefined : key, 'user');
      const now = profiles.sessionProfile(sessionId);
      status(`$(account) ${session.label} opens new tabs in ${now ? (now.name === DEFAULT_PROFILE ? 'the default store' : `"${now.label}"`) : 'the default store'}. Tabs it already has stay where they are.`);
    }),

    vscode.commands.registerCommand('copane.browser.closeProfile', async (profileArg?: unknown) => {
      let key: string | undefined;
      if (typeof profileArg === 'string' && profileArg.trim()) {
        const parsed = parseProfileName(profileArg);
        key = parsed.ok ? parsed.key : undefined;
      } else {
        const items = profiles
          .list()
          .filter(p => p.alive || p.tabIds.length)
          .map(p => ({ label: `$(account) ${p.label}`, description: describe(p), key: p.key }));
        if (!items.length) return void vscode.window.setStatusBarMessage('There is no open login profile.', 5000);
        key = (await vscode.window.showQuickPick(items, { title: 'Close Login Profile', placeHolder: 'Its tabs close and its logins are forgotten.' }))?.key;
      }
      if (!key || key === DEFAULT_PROFILE) return;
      const closed = await profiles.closeProfile(key);
      status(`$(account) Closed "${profiles.label(key)}"${closed ? ` and its ${closed} tab${closed === 1 ? '' : 's'}` : ''}; its logins are gone.`);
    }),
  ];
}
