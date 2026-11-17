// Guidance that tool results repeat (audit caveats, the sign-in hint): said in full the first time a
// session meets it, in a short form afterwards. Pure; one per window, sessions are dropped when they end.

export type NoticeTopic = 'a11y-caveat' | 'perf-caveat' | 'sign-in';

export class SessionNotices {
  private readonly told = new Set<string>();

  /** True the first time `topic` is asked for in this session (and remembers it). */
  first(sessionId: string, topic: NoticeTopic): boolean {
    const key = `${sessionId}\u0000${topic}`;
    if (this.told.has(key)) return false;
    this.told.add(key);
    return true;
  }

  /** The full text the first time in a session, the short form afterwards. */
  pick(sessionId: string, topic: NoticeTopic, full: string, short: string): string {
    return this.first(sessionId, topic) ? full : short;
  }

  dropSession(sessionId: string): void {
    for (const key of [...this.told]) if (key.startsWith(`${sessionId}\u0000`)) this.told.delete(key);
  }
}
