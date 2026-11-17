// Which tools a window offers its agents: the user's settings `copane.tools.profile` and
// `copane.tools.disabled`. Every tool definition costs every conversation, and some clients (GitHub
// Copilot, Codex) load all of them up front, VS Code capping a request at 128 tools across all servers.
// Plain data, no `vscode`: the bridge server applies it when it lists and calls tools.

export type ToolProfile = 'full' | 'core';

export interface ToolSelection {
  /** `full` (default): every tool. `core`: without the tools in `CORE_PROFILE_EXCLUDES`. */
  profile?: string;
  /** Tool names turned off on top of the profile. Unknown names are ignored. */
  disabled?: readonly unknown[];
}

/**
 * The tools the `core` profile leaves out, each with what an agent can do instead (shown when it calls
 * one anyway), or `''` when there is nothing comparable. The everyday loop stays: open, navigate,
 * snapshot, click, type, fill, press, scroll, wait, screenshot, evaluate, console, network, tabs,
 * history, dialogs (a page can block on them), hand-off to the user, and every terminal basic.
 */
export const CORE_PROFILE_EXCLUDES: ReadonlyMap<string, string> = new Map([
  // Dev and test extras: each serves one specialised task and they are the largest definitions.
  ['browser_emulate', ''], // device, viewport, color scheme, throttling: responsive and performance testing
  ['browser_route', ''], // mocking requests: test setups
  ['browser_audit', ''], // accessibility, performance and keyboard audits
  ['browser_check_change', ''], // before/after check of a code change in a dev server
  ['browser_inspect', ''], // element to source file: framework debugging
  ['browser_export_test', ''], // turns the session's steps into a Playwright test
  ['browser_profiles', ''], // separate login stores
  // Rarely used, or covered by another tool.
  ['browser_hover', ''], // hover menus and tooltips only
  ['browser_drag', ''], // drag and drop only
  ['browser_upload_file', ''], // file inputs only
  ['browser_downloads', 'Action results already report downloads they start, with the saved path.'],
  ['browser_show_tab', 'Tell the user in chat which tab to look at.'],
  ['terminal_interrupt', 'Use terminal_send with keys ["Ctrl+C"].'],
  ['session_info', 'window_status shows your session label and the window.'],
]);

/**
 * Tools no setting turns off. `window_status` and `window_select` are how an agent finds out where it
 * is connected and recovers from the wrong window; the MCP server answers them itself and never asks
 * the window, so they are listed here only to say so. Debug tools exist only in a development host.
 */
export function alwaysEnabled(name: string): boolean {
  return name === 'window_status' || name === 'window_select' || name.startsWith('debug_');
}

export function toolProfile(selection: ToolSelection): ToolProfile {
  return selection.profile === 'core' ? 'core' : 'full';
}

/** Why `name` is off, as the setting that turns it off; undefined when it is on. */
export function disabledBy(selection: ToolSelection, name: string): 'copane.tools.profile' | 'copane.tools.disabled' | undefined {
  if (alwaysEnabled(name)) return undefined;
  if (Array.isArray(selection.disabled) && selection.disabled.some(d => typeof d === 'string' && d.trim() === name)) return 'copane.tools.disabled';
  if (toolProfile(selection) === 'core' && CORE_PROFILE_EXCLUDES.has(name)) return 'copane.tools.profile';
  return undefined;
}

export function isToolEnabled(selection: ToolSelection, name: string): boolean {
  return disabledBy(selection, name) === undefined;
}

/** The text of a call to a tool that is off: what happened and what to do instead. */
export function disabledToolMessage(selection: ToolSelection, name: string): string {
  const setting = disabledBy(selection, name) ?? 'copane.tools.disabled';
  const why = setting === 'copane.tools.profile' ? 'the user\'s setting "copane.tools.profile": "core"' : 'the user\'s setting "copane.tools.disabled"';
  const alternative = CORE_PROFILE_EXCLUDES.get(name);
  const instead = alternative && (alternative.match(/\b(?:browser|terminal|session)_[a-z_]+/g) ?? []).every(t => isToolEnabled(selection, t)) ? ` ${alternative}` : '';
  return `${name} is turned off in this VS Code window by ${why}.${instead || ' Continue without it; if the task cannot be done without it, tell the user.'}`;
}
