// Who may read or type in which terminal. Pure, so the rules are unit-tested.
//
// - A session uses its own terminals freely, and terminals whose owning session has ended.
// - The user's own terminals need the user's permission (setting `copane.terminal.userTerminals`).
// - Another live session's terminal needs the user's permission too: sessions do not share by default.

export type UserTerminalPolicy = 'ask' | 'allow' | 'deny';

export interface AccessSubject {
  origin: 'agent' | 'user';
  /** The owning session's id (origin "agent"), whether or not it is still connected. */
  ownerKey: string | undefined;
  /** The owning session still exists in this window. */
  ownerAlive: boolean;
  /** Sessions the user allowed to use this terminal. */
  granted: ReadonlySet<string>;
  /** Sessions the user recently refused, with the time the refusal expires. */
  refusedUntil: ReadonlyMap<string, number>;
}

export type AccessDecision =
  | { kind: 'allowed' }
  /** Ask the user; `reason` tells which kind of prompt to show. */
  | { kind: 'ask'; reason: 'user-terminal' | 'other-session' }
  | { kind: 'denied'; reason: 'policy' | 'refused' };

export function decideAccess(subject: AccessSubject, sessionId: string, policy: UserTerminalPolicy, now: number): AccessDecision {
  if (subject.origin === 'agent') {
    if (subject.ownerKey === sessionId || !subject.ownerAlive || subject.granted.has(sessionId)) return { kind: 'allowed' };
    if ((subject.refusedUntil.get(sessionId) ?? 0) > now) return { kind: 'denied', reason: 'refused' };
    return { kind: 'ask', reason: 'other-session' };
  }
  if (policy === 'deny') return { kind: 'denied', reason: 'policy' };
  if (policy === 'allow' || subject.granted.has(sessionId)) return { kind: 'allowed' };
  if ((subject.refusedUntil.get(sessionId) ?? 0) > now) return { kind: 'denied', reason: 'refused' };
  return { kind: 'ask', reason: 'user-terminal' };
}

export function parsePolicy(value: unknown): UserTerminalPolicy {
  return value === 'allow' || value === 'deny' ? value : 'ask';
}

export type SessionEndPolicy = 'keep' | 'closeIdle' | 'close';

export function parseSessionEndPolicy(value: unknown): SessionEndPolicy {
  return value === 'close' || value === 'closeIdle' ? value : 'keep';
}

/** Ownership records kept in workspace state, so agent terminals stay agent terminals across a reload. */
export interface PersistedTerminal {
  id: string;
  /** Shell process id: the same after a window reload (the pty host keeps running). */
  pid: number | undefined;
  name: string;
  ownerKey: string | undefined;
  createdAt: number;
  /** The owning session's label the name was made from ("Claude 2", or the session's name); absent in records of older versions. */
  label?: string;
}

/** The session label a terminal name starts with: "Claude 2" in "Claude 2", "Claude 2: dev server", "Claude 2 (3)". */
export function labelPrefix(name: string): string | undefined {
  return /^((?:Claude|Codex|Copilot|Agent) \d+)(?=$|: | \(\d+\)$)/.exec(name)?.[1];
}

/**
 * The name a terminal should have now that its owner is labelled `current` (another number after a
 * reload, or a name the user or agent gave the session), or undefined when it is right, or when it
 * was renamed away from the label by the user, which is theirs to keep. A name made from a label is
 * the label, "<label>: <terminal name>" or "<label> (<n>)".
 */
export function renamedFor(name: string, madeFrom: string | undefined, current: string): string | undefined {
  if (!madeFrom || madeFrom === current || !name.startsWith(madeFrom)) return undefined;
  const rest = name.slice(madeFrom.length);
  return rest === '' || rest.startsWith(': ') || /^ \(\d+\)$/.test(rest) ? current + rest : undefined;
}

/**
 * Matches a terminal found after activation to a persisted record: by process id first, then by a
 * name only one unclaimed record has (a full restart revives terminals with new processes).
 */
export function matchPersisted(records: readonly PersistedTerminal[], claimed: ReadonlySet<string>, pid: number | undefined, name: string): PersistedTerminal | undefined {
  const open = records.filter(r => !claimed.has(r.id));
  if (pid !== undefined) {
    const byPid = open.find(r => r.pid === pid);
    if (byPid) return byPid;
  }
  const byName = open.filter(r => r.name === name);
  return byName.length === 1 ? byName[0] : undefined;
}
