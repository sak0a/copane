// Old tool names that still answer after their tools were merged into others, so agents and saved
// prompts that use them keep working for one release. The bridge server maps a call to an old name to
// the new call (`resolveToolAlias`) and starts its result with a line naming the new call. Aliases are
// never listed in tools/list, and the user's `copane.tools.*` settings apply to the new tool (and to
// the old name, if the user turned that off by name).
// Plain data, no `vscode`.
//
// REMOVE this file, its use in bridgeServer.ts, its unit test and the e2e case in core.e2e.mjs in the
// release after the one that first ships the merged tools (they merged after 0.3.0, so: remove in the
// release after 0.4.0). The changelog keeps the mapping.
import type { CallToolResult } from '../../shared/protocol';
import { unknownArgumentsMessage } from './tools';

interface ToolAlias {
  /** The tool that does it now. */
  tool: string;
  /** The argument names the old tool took; they pass through unchanged. */
  args: readonly string[];
  /** Arguments the new call adds to say what the old tool did. */
  fixed: Readonly<Record<string, unknown>>;
  /** Old arguments worth showing in the note, next to `fixed`. */
  shown?: readonly string[];
}

/** Old name → new call. The one table of aliases. */
export const TOOL_ALIASES: ReadonlyMap<string, ToolAlias> = new Map<string, ToolAlias>([
  ['browser_select_tab', { tool: 'browser_tab', args: ['tab'], fixed: { action: 'select' } }],
  ['browser_show_tab', { tool: 'browser_tab', args: ['tab'], fixed: { action: 'show' } }],
  ['browser_release_tab', { tool: 'browser_tab', args: ['tab', 'all'], fixed: { action: 'release' } }],
  ['browser_close_tab', { tool: 'browser_tab', args: ['tab'], fixed: { action: 'close' } }],
  ['browser_history', { tool: 'browser_navigate', args: ['action', 'ignoreCache', 'waitUntil', 'timeout', 'tab'], fixed: {}, shown: ['action'] }],
  ['terminal_interrupt', { tool: 'terminal_send', args: ['terminal'], fixed: { keys: ['Ctrl+C'] } }],
]);

export type AliasCall =
  /** Call `name` with `args`, and start the result with `note`. */
  | { name: string; args: Record<string, unknown>; note: string }
  /** Arguments the old tool did not take: refuse with this message. */
  | { name: string; error: string; note: string };

/** The new call for a call to an old tool name, or undefined when `name` is not an old name. */
export function resolveToolAlias(name: string, rawArgs: unknown): AliasCall | undefined {
  const alias = TOOL_ALIASES.get(name);
  if (!alias) return undefined;
  const old = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const shown: Record<string, unknown> = { ...alias.fixed };
  for (const key of alias.shown ?? []) if (old[key] !== undefined) shown[key] = old[key];
  const note = `(${name} is now ${alias.tool} ${JSON.stringify(shown)}: call that from now on; the old name will be removed.)`;
  const unknown = unknownArgumentsMessage(name, alias.args, rawArgs);
  if (unknown) return { name: alias.tool, error: unknown, note };
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(old)) if (alias.args.includes(key) || key === '_meta') args[key] = value;
  return { name: alias.tool, args: { ...args, ...alias.fixed }, note };
}

/** `result` with `note` as its first line. */
export function withAliasNote(result: CallToolResult, note: string): CallToolResult {
  const [first, ...rest] = result.content;
  if (first?.type === 'text') return { ...result, content: [{ ...first, text: `${note}\n${first.text}` }, ...rest] };
  return { ...result, content: [{ type: 'text', text: note }, ...result.content] };
}
