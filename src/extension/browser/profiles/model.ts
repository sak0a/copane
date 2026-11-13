// Login profiles, as data: names, which profile a new tab of a session uses, what is remembered across
// a window reload, and the sentences that explain a profile's lifetime. No `vscode` here (unit-tested in
// test/unit/browser-profiles.test.ts).
//
// A profile is a separate in-memory login store (cookies, local storage, cache) of VS Code's integrated
// browser: a CDP browser context. Tabs of one profile share it; tabs of other profiles and of the
// window's default store do not. What was established about its lifetime (VS Code 1.146, see
// docs/browser-profiles.md):
//   - closing a tab, even the last tab of a profile: logins stay while Copane's browser session that
//     created the profile is open (until the window reloads or the extension host restarts);
//   - window reload / extension host restart: the profile's open tabs keep their logins, and new tabs
//     can join them; a profile with no open tab is lost;
//   - VS Code restart: every profile is lost; restored tabs come back each in a separate empty store.

/** The profile key of the window's default store (what tabs use without a profile). */
export const DEFAULT_PROFILE = 'default';
/** Prefix of the key of a session's private profile: "private:<session id>". Not typeable as a name. */
export const PRIVATE_PREFIX = 'private:';

export type AgentLoginStoreSetting = 'shared' | 'private';

/** Names the agent or user can give: "dev", "ztb-pre", "test.2". Case-insensitive; stored lowercase. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export type ParsedProfile = { ok: true; key: string } | { ok: false; message: string };

/**
 * Parses a profile name given by the agent or the user. "default" or "shared" mean the default store;
 * "private" means the session's own private profile (needs `sessionId`).
 */
export function parseProfileName(input: string, sessionId?: string): ParsedProfile {
  const name = input.trim().toLowerCase();
  if (name === DEFAULT_PROFILE || name === 'shared' || name === 'none') return { ok: true, key: DEFAULT_PROFILE };
  if (name === 'private') {
    if (!sessionId) return { ok: false, message: '"private" means an agent session\'s own profile; pick a session first.' };
    return { ok: true, key: privateKey(sessionId) };
  }
  if (!NAME.test(name)) {
    return {
      ok: false,
      message: `"${input}" is not a valid profile name: use 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or digit (e.g. "dev", "ztb-pre").`,
    };
  }
  return { ok: true, key: name };
}

export function privateKey(sessionId: string): string {
  return `${PRIVATE_PREFIX}${sessionId}`;
}

export function isPrivate(key: string): boolean {
  return key.startsWith(PRIVATE_PREFIX);
}

/** The session a private profile belongs to. */
export function privateOwner(key: string): string | undefined {
  return isPrivate(key) ? key.slice(PRIVATE_PREFIX.length) : undefined;
}

/** How a profile is named to people and models: "dev", "private to Claude 2". */
export function profileLabel(key: string, sessionLabel: (sessionId: string) => string | undefined): string {
  if (key === DEFAULT_PROFILE) return 'default store';
  const owner = privateOwner(key);
  if (owner !== undefined) return `private to ${sessionLabel(owner) ?? 'an ended session'}`;
  return key;
}

export interface SessionDefaults {
  /** Set by the user for this session (Sessions view). Wins over the agent's own choice. */
  user?: string;
  /** Set by the agent for itself (browser_profiles). */
  agent?: string;
}

export type ProfileSource = 'argument' | 'user' | 'agent' | 'setting';

/**
 * Which profile a new tab opened by a session uses. One line: the `profile` argument, else the default
 * the user set for the session, else the one the agent set for itself, else the setting (`shared`: the
 * default store; `private`: the session's private profile).
 */
export function resolveProfile(input: {
  sessionId: string;
  explicit?: string;
  defaults?: SessionDefaults;
  setting: AgentLoginStoreSetting;
}): { key: string; source: ProfileSource } {
  if (input.explicit !== undefined) return { key: input.explicit, source: 'argument' };
  if (input.defaults?.user !== undefined) return { key: input.defaults.user, source: 'user' };
  if (input.defaults?.agent !== undefined) return { key: input.defaults.agent, source: 'agent' };
  return input.setting === 'private' ? { key: privateKey(input.sessionId), source: 'setting' } : { key: DEFAULT_PROFILE, source: 'setting' };
}

/**
 * Whether an agent may open a tab in the default store. With the setting "private" agents keep out of
 * the user's logins unless the user chose the default store for that session themselves.
 */
export function agentMayUseDefault(setting: AgentLoginStoreSetting, source: ProfileSource): boolean {
  return setting === 'shared' || source === 'user';
}

// ------------------------------------------------------------------ remembered across a window reload

export interface PersistedProfileTab {
  /** VS Code's browser view id (stable across reloads and restarts). */
  viewId: string;
  profile: string;
  /** The browser context the tab was in. Same after a reload; a different "ephemeral:..." after a restart. */
  contextId: string;
  /** The tab already lost its profile (VS Code restarted) and has a store of its own. */
  detached?: boolean;
}

export interface PersistedProfiles {
  version: 1;
  /** Profile key → its browser context id when last seen. */
  contexts: Record<string, string>;
  tabs: PersistedProfileTab[];
  /** Session id → defaults. */
  defaults: Record<string, SessionDefaults>;
  /** Names used in this window, newest first, offered in the user's pick list even with no tab open. */
  recent: string[];
}

export function emptyProfiles(): PersistedProfiles {
  return { version: 1, contexts: {}, tabs: [], defaults: {}, recent: [] };
}

const validKey = (k: unknown): k is string => typeof k === 'string' && (k === DEFAULT_PROFILE || NAME.test(k) || (k.startsWith(PRIVATE_PREFIX) && k.length > PRIVATE_PREFIX.length));

/** Accepts whatever was stored (possibly by another build) and returns a valid state. */
export function parseProfiles(raw: unknown): PersistedProfiles {
  const state = emptyProfiles();
  if (!raw || typeof raw !== 'object' || (raw as any).version !== 1) return state;
  const r = raw as Partial<PersistedProfiles>;
  if (r.contexts && typeof r.contexts === 'object') {
    for (const [k, v] of Object.entries(r.contexts)) if (validKey(k) && k !== DEFAULT_PROFILE && typeof v === 'string') state.contexts[k] = v;
  }
  if (Array.isArray(r.tabs)) {
    state.tabs = r.tabs
      .filter(t => t && typeof t.viewId === 'string' && validKey(t.profile) && t.profile !== DEFAULT_PROFILE && typeof t.contextId === 'string')
      .map(t => ({ viewId: t.viewId, profile: t.profile, contextId: t.contextId, ...(t.detached === true ? { detached: true } : {}) }));
  }
  if (r.defaults && typeof r.defaults === 'object') {
    for (const [sessionId, d] of Object.entries(r.defaults)) {
      if (!d || typeof d !== 'object') continue;
      const out: SessionDefaults = {};
      if (validKey((d as SessionDefaults).user)) out.user = (d as SessionDefaults).user;
      if (validKey((d as SessionDefaults).agent)) out.agent = (d as SessionDefaults).agent;
      if (out.user !== undefined || out.agent !== undefined) state.defaults[sessionId] = out;
    }
  }
  if (Array.isArray(r.recent)) state.recent = r.recent.filter(k => validKey(k) && k !== DEFAULT_PROFILE && !isPrivate(k)).slice(0, 20);
  return state;
}

/** Puts a name first in the recent list. */
export function touchRecent(recent: readonly string[], key: string): string[] {
  if (key === DEFAULT_PROFILE || isPrivate(key)) return [...recent];
  return [key, ...recent.filter(k => k !== key)].slice(0, 20);
}

/**
 * What a tab restored after a reload or restart is, given what was remembered about it and the browser
 * context it is in now: still in its profile (reload: the context lived on), or a tab that has its own
 * empty store now (restart: VS Code gave it a new in-memory store), or nothing Copane knows.
 */
export function classifyRestoredTab(
  remembered: PersistedProfileTab | undefined,
  contextId: string | undefined,
): { kind: 'profile'; profile: string } | { kind: 'detached'; formerProfile: string } | undefined {
  if (!remembered || !contextId) return undefined;
  if (remembered.detached) return { kind: 'detached', formerProfile: remembered.profile };
  if (contextId === remembered.contextId) return { kind: 'profile', profile: remembered.profile };
  return { kind: 'detached', formerProfile: remembered.profile };
}

// ------------------------------------------------------------------ sentences

/** Why a profile's earlier logins are gone, said once when it is next opened. */
export const LOST = {
  restart: 'VS Code was restarted, and profiles live in memory only',
  orphaned: 'none of its tabs was open when the window reloaded or Copane restarted',
  unreachable: 'VS Code no longer knows its login store',
} as const;
export type LostReason = keyof typeof LOST;

/** One sentence about how long a profile's logins live; for tool results, tooltips and the user command. */
export const LIFETIME =
  'Profile logins live in memory only, never on disk: they last until VS Code quits, also with no tab open, but a window reload (or restart of the extension) loses a profile that has no tab open at that moment.';

export const ISOLATION_NOTE =
  'A profile separates logins between tabs; it does not hide them from agent sessions that use its tabs.';
