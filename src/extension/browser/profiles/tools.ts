import { z } from 'zod';
import { ToolError } from '../../core/errors';
import type { BridgeServices } from '../../core/services';
import { defineTool, type ToolDefinition } from '../../core/tools';
import type { BrowserServiceImpl } from '../service';
import { agentLoginStoreSetting, type ProfileManager } from './manager';
import { DEFAULT_PROFILE, ISOLATION_NOTE, LIFETIME, LOST, parseProfileName, privateKey, resolveProfile } from './model';

/** Which store browser_open uses, in one line (also in browser_open's `profile` description). */
export const PRECEDENCE =
  "Which store a new tab uses: browser_open's `profile`, else the default the user set for your session, else the one you set with browser_profiles, else the user's setting (the shared default store, or a private profile per session).";

export function profileTools(services: BridgeServices, browser: BrowserServiceImpl, profiles: ProfileManager): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_profiles',
      title: 'Browser login profiles',
      description:
        'Lists login profiles: separate cookie and login stores for browser tabs (e.g. "dev", "test", "prod" signed in as different accounts). Tabs of one profile share logins; other tabs do not. With `default`, sets the profile your browser_open uses when you pass none. ' +
        PRECEDENCE,
      input: {
        default: z
          .string()
          .optional()
          .describe('Profile name for your new tabs, "private" for a profile of your own, "default" for the shared store, "" to clear your choice.'),
      },
      handler: async (args, ctx) => {
        browser.assertAvailable();
        await profiles.ready;
        const lines: string[] = [];
        if (args.default !== undefined) {
          if (args.default.trim() === '') {
            profiles.setDefault(ctx.session.id, undefined, 'agent');
            lines.push('Cleared your default profile.');
          } else {
            const parsed = parseProfileName(args.default, ctx.session.id);
            if (!parsed.ok) throw new ToolError('invalid_input', parsed.message);
            if (parsed.key === DEFAULT_PROFILE && agentLoginStoreSetting() === 'private' && profiles.defaultsOf(ctx.session.id).user !== DEFAULT_PROFILE) {
              throw new ToolError('access_denied', "The user's setting copane.browser.agentLoginStore is \"private\": agent sessions do not use the window's default login store.");
            }
            profiles.setDefault(ctx.session.id, parsed.key, 'agent');
            lines.push(`Your new tabs open in ${parsed.key === DEFAULT_PROFILE ? 'the shared default store' : `the profile "${profiles.label(parsed.key)}"`} from now on.`);
          }
        }
        const defaults = profiles.defaultsOf(ctx.session.id);
        const current = resolveProfile({ sessionId: ctx.session.id, defaults, setting: agentLoginStoreSetting() });
        const name = (key: string) => (key === DEFAULT_PROFILE ? 'the shared default store' : key === privateKey(ctx.session.id) ? 'your private profile' : `"${profiles.label(key)}"`);
        const by = { argument: '', user: ' (set by the user; it wins over yours)', agent: ' (set by you)', setting: " (the user's setting)" }[current.source];
        lines.push(`Your new tabs open in ${name(current.key)}${by}.`);
        if (defaults.user !== undefined && defaults.agent !== undefined && defaults.agent !== defaults.user) {
          lines.push(`Your own choice ${name(defaults.agent)} applies only once the user clears theirs; pass \`profile\` to browser_open to use another profile for one tab.`);
        }
        // Other sessions' private profiles are theirs; their tabs still show in browser_list_tabs.
        const all = profiles.list().filter(p => !p.key.startsWith('private:') || p.key === privateKey(ctx.session.id));
        if (all.length === 0) lines.push('No profiles yet. browser_open with `profile: "<name>"` creates one.');
        for (const p of all) {
          const state = p.alive
            ? p.tabIds.length
              ? `tabs ${p.tabIds.join(', ')}`
              : p.keptWithoutTabs
                ? 'no tab open, logins kept'
                : 'no tab open'
            : p.lost
              ? `logins lost (${LOST[p.lost]}); the next tab starts logged out`
              : 'no login store yet; the next tab starts logged out';
          lines.push(`- ${p.key === privateKey(ctx.session.id) ? 'private (yours)' : p.label}: ${state}`);
        }
        lines.push(LIFETIME, ISOLATION_NOTE);
        return lines.join('\n');
      },
    }),
  ];
}
