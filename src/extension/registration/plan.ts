// What to do about one agent's registration, decided from plain data so every rule is unit-tested.
// The startup check and "Check and Repair" both use it; the only way an entry is rewritten or removed
// is an action decided here (or the explicit Turn On / Turn Off commands), always with a reason.
import { MCP_SERVER_NAME } from '../../shared/protocol';
import type { EntryState } from './claudeCode';

export type Mode = 'ask' | 'automatic' | 'manual';

export interface PlanInput {
  agent: string;
  state: EntryState;
  mode: Mode;
  /** The user's recorded answer for this agent: agreed (Register / Turn On), turned off, or not asked. */
  consent: 'granted' | 'declined' | undefined;
  /** When the user agreed, for the reason text. */
  consentAt?: string;
  detected: boolean;
  /** A safety guard (development host without throwaway config). */
  blocked?: string;
  /** "Not now" was answered recently. */
  snoozed: boolean;
  /** How often the startup check has re-added a missing entry in the last 24 hours. */
  recentReAdds: number;
}

export type Plan =
  /** Nothing to do. `note` says what was found, for the log and the repair report. */
  | { action: 'none'; note: string }
  /** Write the entry: add a missing one, or update our own outdated one in place (one atomic step). */
  | { action: 'add' | 'update'; reason: string }
  /** Ask the user whether to register (mode "ask", never asked). */
  | { action: 'ask' }
  /** Ask whether to replace another server named like ours (repair only). */
  | { action: 'ask-replace'; command: string }
  /** Something is wrong that is not changed without the user: say what and what to do. */
  | { action: 'report'; problem: string };

/** After this many automatic re-adds in 24 hours the startup check stops and tells the user. */
export const MAX_AUTO_READDS = 3;

/** Command names as the user sees them in the Command Palette (read from the manifest at runtime). */
export interface CommandTitles {
  /** The extension's name in messages (the command category). */
  product: string;
  turnOn: string;
  turnOff: string;
  repair: string;
  status: string;
  copy: string;
  log: string;
}

export const DEFAULT_TITLES: CommandTitles = {
  product: 'Copane',
  turnOn: 'Copane: Turn On',
  turnOff: 'Copane: Turn Off',
  repair: 'Copane: Check and Repair Setup',
  status: 'Copane: Show Status',
  copy: 'Copane: Copy Status Report',
  log: 'Copane: Show Log',
};

export function planAgent(input: PlanInput, trigger: 'startup' | 'repair', titles: CommandTitles = DEFAULT_TITLES): Plan {
  const { state, mode, consent } = input;
  const TURN_ON = `run "${titles.turnOn}" to register it again`;
  if (input.blocked) return trigger === 'repair' ? { action: 'report', problem: `changes are blocked: ${input.blocked}` } : { action: 'none', note: `blocked: ${input.blocked}` };
  switch (state.kind) {
    case 'unreadable':
      return { action: 'report', problem: `its config cannot be read (${state.error}); nothing was changed` };
    case 'foreign':
      if (trigger === 'repair') return { action: 'ask-replace', command: state.command };
      return { action: 'report', problem: `another MCP server named "${MCP_SERVER_NAME}" is configured (${state.command}); ${titles.product} leaves it alone` };
    case 'ours':
      if (state.current) return { action: 'none', note: 'registered and current' };
      if (trigger === 'startup' && mode === 'manual') {
        return { action: 'report', problem: `the registration is out of date (${state.reason ?? 'differs'}) and registration mode is "manual"; run "${titles.repair}"` };
      }
      return { action: 'update', reason: `the registered entry is out of date: ${state.reason ?? `it differs from what ${titles.product} registers now`}` };
    case 'absent':
      break;
  }
  if (!input.detected) return { action: 'none', note: 'not installed' };
  if (consent === 'declined') {
    return trigger === 'repair' ? { action: 'report', problem: `not registered, because it was turned off; ${TURN_ON}` } : { action: 'none', note: 'turned off by the user' };
  }
  if (trigger === 'repair') {
    return { action: 'add', reason: consent === 'granted' ? 'the entry was missing although registration was agreed to' : 'not registered yet; "Check and Repair" registers it' };
  }
  if (consent === 'granted') {
    if (mode === 'manual') return { action: 'report', problem: `the entry is missing although registration was agreed to, and registration mode is "manual"; ${TURN_ON}` };
    if (input.recentReAdds >= MAX_AUTO_READDS) {
      return {
        action: 'report',
        problem:
          `the entry keeps disappearing (re-added ${input.recentReAdds} times in 24 hours), so it is not re-added again automatically. ` +
          `Something outside ${titles.product} removes it; run "${titles.repair}", and "${titles.status}" shows the history`,
      };
    }
    return {
      action: 'add',
      reason:
        `the entry was missing although registration was agreed to${input.consentAt ? ` on ${input.consentAt.slice(0, 10)}` : ''} ` +
        `(removed outside ${titles.product}, e.g. \`claude mcp remove\`, or Claude Code reset its config); to keep it off, run "${titles.turnOff}"`,
    };
  }
  if (mode === 'automatic') return { action: 'add', reason: 'registration mode is "automatic"' };
  if (mode === 'ask' && !input.snoozed) return { action: 'ask' };
  return { action: 'none', note: mode === 'manual' ? 'not registered (mode "manual")' : 'not registered (asked recently: "Not Now")' };
}
