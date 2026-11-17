// The services every module receives from `activate`. Modules talk to each other only through these
// interfaces, never by importing each other's internals.
import type * as vscode from 'vscode';
import type { WindowDescriptor } from '../../shared/protocol';
import type { Event } from './events';
import type { LeaseManager } from './leases';
import type { Logger } from './log';
import type { PromptService } from './prompts';
import type { AgentSession, SessionManager } from './sessions';
import type { ToolRegistry } from './tools';

export interface BridgeServices {
  readonly context: vscode.ExtensionContext;
  readonly log: Logger;
  readonly window: WindowDescriptor;
  readonly sessions: SessionManager;
  readonly tools: ToolRegistry;
  /** Asks the user a question. Use this instead of `vscode.window.show*Message` for anything an agent waits on. */
  readonly prompts: PromptService;
  /** Control leases for browser tabs. Resource id = tab id. */
  readonly tabLeases: LeaseManager;
  /** Set by the browser module during activation. */
  browser: BrowserService;
  /** Set by the terminal module during activation. */
  terminals: TerminalService;
  /** Set by the remote module during activation: the user's machine as seen from a remote window. */
  remote?: RemoteService;
  /** Set by the registration module during activation: how agents start the MCP server. */
  mcpServer?: McpServerLaunch;
}

// ---------------------------------------------------------------- MCP server launch

/**
 * The stdio command agents are registered with (the launcher in the bridge home, which survives
 * extension updates). In a remote window it is a path on the remote side, where this extension runs.
 */
export interface McpServerLaunch {
  spec(): { readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
  /** Why the server could not be installed in the bridge home, or undefined when it is in place. */
  installError(): string | undefined;
  /** Fires when `spec()` or `installError()` may have changed (the server was installed again). */
  readonly onDidChange: Event<void>;
}

// ---------------------------------------------------------------- Remote windows

/**
 * In a remote window (WSL, SSH, containers) this extension host runs on the remote machine, next to the
 * agent, while VS Code's UI and the integrated browser run on the user's machine. Files there are
 * reached through `vscode.workspace.fs` with the scheme `vscode-local` (VS Code maps it to the UI side's
 * `file` scheme); this service finds the folders on that side.
 */
export interface RemoteService {
  /** `vscode.env.remoteName` ("wsl", "ssh-remote", "dev-container" ...); undefined in a local window. */
  readonly remoteName: string | undefined;
  /** Where this extension host (and the agent) runs, for messages: "WSL (Ubuntu)", "the SSH host build-1", "the container". */
  readonly where: string;
  /** The user's machine: their home folder and its platform, or why it could not be found. */
  uiHome(): Promise<UiMachine | { error: string }>;
  /** A private folder on the user's machine (created on demand) the browser can save files into. */
  uiFolder(kind: 'download-staging' | 'downloads'): Promise<UiFolder | { error: string }>;
  /** argv.json of the user's VS Code (it may not exist yet), or why it could not be found. */
  uiArgvJson(): Promise<UiFolder | { error: string }>;
  /** Records where VS Code itself opened argv.json ("Configure Runtime Arguments"), which tells the home folder. */
  learnArgvJson(uri: vscode.Uri): void;
}

export interface UiMachine {
  platform: 'win32' | 'darwin' | 'linux';
  home: UiFolder;
}

/** A file or folder on the user's machine. */
export interface UiFolder {
  /** As this extension host addresses it (scheme `vscode-local`). */
  readonly uri: vscode.Uri;
  /** As the user's machine writes it, e.g. `C:\Users\me\Downloads`: for the browser and for messages. */
  readonly nativePath: string;
}

// ---------------------------------------------------------------- Browser

/** What a session is allowed to do with a tab. */
export type TabAccess =
  /** Look only: snapshot, screenshot, console, network. Never blocked by another session's lease. */
  | 'read'
  /** Change the page: click, type, navigate, evaluate. Takes the tab's control lease. */
  | 'control';

export interface BrowserTabInfo {
  /** Short id, unique in this window and stable for the lifetime of the tab, e.g. "tab-3". */
  id: string;
  url: string;
  title: string;
  /** True for the browser tab that is active in the editor area. */
  active: boolean;
  /** Who opened it: an agent session via a tool, or the user through the VS Code UI. */
  origin: 'agent' | 'user';
  /** The session that opened it (origin "agent"), if that session still exists. */
  openedBy: string | undefined;
  /** The session currently holding the control lease. */
  controlledBy: string | undefined;
  /** Sessions the user allowed to control this tab (always includes the opener). */
  allowedSessions: string[];
  /** The user has taken over: agent actions on this tab are refused until they resume it. */
  paused: boolean;
  /** VS Code's own id of the browser view; the editor tab's resource is `vscode-browser:/<viewId>`. Known once the tab has been attached. */
  viewId?: string;
  /** For a tab a page opened (popup, `target=_blank`) while a session controlled it: the tab it came from. */
  openerTab?: string;
  /**
   * Device or media emulation an agent session turned on in this tab (phone size, dark scheme, locale...).
   * It ends when that session stops controlling the tab; the user can end it with the command
   * `copane.browser.resetEmulation` (argument: the tab id).
   */
  emulation?: {
    sessionId: string;
    /** Short, for a badge or a list row: "iPhone 15 Pro · dark". */
    label: string;
    /** One sentence for a tooltip: "iPhone 15 Pro (393×852 CSS px at 3×, mobile with touch), dark colour scheme". */
    description: string;
  };
  /** Downloads agent sessions started in this tab during this window's lifetime (newest first, at most 5). */
  downloads?: Array<{
    /** "dl-3" */
    id: string;
    name: string;
    sessionId: string | undefined;
    state: 'downloading' | 'waiting-for-user' | 'saved' | 'not-saved' | 'failed' | 'elsewhere';
    /** Percent, while downloading and the size is known. */
    progress?: number;
    /** Where the file was saved (state "saved"). */
    path?: string;
  }>;
  /**
   * Request-mocking rules (browser_route) active in this tab, per session that set them; absent when
   * none. While present, some of the tab's requests get canned responses, errors or delays.
   */
  requestRules?: Array<{ sessionId: string; rules: number }>;
  /**
   * Set while an agent session has handed the tab to the user (browser_request_user_input) and waits
   * for them: what it asked for, and which session asked. The tab is `paused` meanwhile.
   */
  request?: { sessionId: string; message: string; since: number };
  /**
   * The login profile of the tab: a separate in-memory store of cookies, local storage and cache that
   * only tabs of the same profile share. Absent: the window's default store (shared by all tabs without
   * a profile). `kind` "detached": the tab was in `name` before VS Code restarted and now has an empty
   * store of its own (profiles live in memory only).
   */
  profile?: {
    /** "dev"; for a session's private profile "private:<session id>". */
    name: string;
    /** For rows and the page indicator: "dev", "private to Claude 2". */
    label: string;
    kind: 'named' | 'private' | 'detached';
    /** One sentence for a tooltip. */
    description: string;
  };
}

/** A CDP connection to one tab's page target. Shared by all sessions that use the tab. */
export interface CdpPage {
  readonly tabId: string;
  readonly closed: boolean;
  /** Sends a CDP command to the page target, e.g. `send('Page.navigate', { url })`. */
  send<T = any>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  /** Subscribes to a CDP event of the page target, e.g. `on('Runtime.consoleAPICalled', ...)`. */
  on(event: string, listener: (params: any) => void): vscode.Disposable;
  readonly onDidClose: Event<void>;
  /**
   * The same connection scoped to a child target session: an out-of-process (cross-origin) iframe the
   * page session attached to with `Target.setAutoAttach` (flatten), announced by `Target.attachedToTarget`.
   * `send` and `on` then address that session only; its failures never close the page connection. It
   * closes when the child detaches or this connection closes. Optional so test fakes stay valid.
   */
  childSession?(sessionId: string): CdpPage;
}

export interface BrowserService {
  /** False when the proposed `browser` API is not enabled; every other member then throws ToolError. */
  readonly available: boolean;
  /** Fires when tabs open, close, navigate, or their ownership, lease or paused state changes. */
  readonly onDidChange: Event<void>;
  /** Fires once per tab when its CDP connection is first established (and again after a re-attach). */
  readonly onDidAttachPage: Event<CdpPage>;
  listTabs(): BrowserTabInfo[];
  getTab(tabId: string): BrowserTabInfo | undefined;
  /**
   * The single entry point for tools that touch a page. Resolves the tab (`tabId` undefined = the
   * session's current tab), checks consent and the pause state, takes or renews the lease for
   * "control", and returns the CDP connection. Throws ToolError with a message for the agent.
   */
  acquire(session: AgentSession, tabId: string | undefined, access: TabAccess, signal?: AbortSignal): Promise<{ tab: BrowserTabInfo; page: CdpPage }>;
  /** `profile`: a login profile name (see `BrowserTabInfo.profile`); omitted: the session's default. */
  openTab(session: AgentSession, url: string, options?: { background?: boolean; profile?: string }): Promise<BrowserTabInfo>;
  closeTab(tabId: string): Promise<void>;
  /** Brings the tab to the front in the editor area. */
  revealTab(tabId: string): Promise<void>;
  /**
   * Establishes the tab's CDP connection without an agent session (firing `onDidAttachPage` if it is
   * new), e.g. to undo state an earlier run of the extension left in the tab. Optional so fakes stay valid.
   */
  attach?(tabId: string): Promise<CdpPage>;
  /** Ends a session's control of a tab (or whoever controls it when `sessionId` is omitted). */
  releaseTab(tabId: string, sessionId?: string): void;
  /** User takeover: while paused, agents cannot act on the tab. */
  setPaused(tabId: string, paused: boolean): void;
  /**
   * Why a URL's certificate error was not accepted just now (the user said no, did not answer, or the
   * setting forbids it), or undefined when no certificate error was refused for its host recently.
   */
  certificateRefusal?(url: string): string | undefined;
  /** Fires once per new tab, after it is attributed (agent tab, popup of an agent tab, or user tab). */
  readonly onDidOpenTab?: Event<BrowserTabInfo>;
  /** The user shares one of their tabs with a session (as if they had answered "Allow"). */
  grantAccess?(tabId: string, sessionId: string): void;
  /** Withdraws what the user allowed or denied for a tab (all sessions, or one), so the next use asks again. */
  revokeAccess?(tabId: string, sessionId?: string): void;
  /**
   * Ends a pending hand-off of the tab (see `BrowserTabInfo.request`) on behalf of the user: "done"
   * gives the tab back to the agent, "declined" tells it the user will not do it. Returns false when
   * nothing was pending.
   */
  resolveUserRequest?(tabId: string, outcome: 'done' | 'declined'): boolean;
  /**
   * The login profile new tabs of a session open in when it names none, and who chose it; undefined
   * while that is the window's default store by default. Set by login profiles.
   */
  sessionProfile?(sessionId: string): { name: string; label: string; setBy: 'user' | 'agent' | 'setting' } | undefined;
}

// ---------------------------------------------------------------- Terminals

export type TerminalState =
  | 'starting'
  /** At a prompt, nothing running. */
  | 'idle'
  /** A command is running. */
  | 'running'
  /** The agent asked the user to do something in this terminal and is waiting. */
  | 'waiting-for-user'
  | 'closed';

export interface TerminalInfo {
  /** Short id, unique in this window, e.g. "term-2". */
  id: string;
  name: string;
  /** Created by an agent session via a tool, or by the user. */
  origin: 'agent' | 'user';
  /** The session that owns it (origin "agent"), if that session still exists. */
  ownedBy: string | undefined;
  state: TerminalState;
  /** Whether shell integration is active, which is what makes output and exit codes available. */
  shellIntegration: boolean;
  cwd: string | undefined;
  /** The command line currently running, if any. */
  currentCommand: string | undefined;
  lastExitCode: number | undefined;
  /** Sessions the user allowed to use this terminal although they do not own it. The UI lists it under each of them. */
  allowedSessions?: string[];
  /** Set while state is "waiting-for-user": what the agent asked the user to do, and which session asked. */
  request?: { sessionId: string; message: string; since: number };
  /** Same as `request.message`: what the agent asked the user to do, in its own words (e.g. "Log in to npm"). */
  userInputRequest?: string;
}

export interface TerminalService {
  /** Fires when terminals open or close, or their state or ownership changes. */
  readonly onDidChange: Event<void>;
  list(): TerminalInfo[];
  get(terminalId: string): TerminalInfo | undefined;
  /** Shows the terminal panel with this terminal selected. */
  reveal(terminalId: string, options?: { preserveFocus?: boolean }): void;
  /** Sends Ctrl+C. */
  interrupt(terminalId: string): void;
  close(terminalId: string): void;
  /**
   * Ends a pending hand-off (state "waiting-for-user") on behalf of the user: "done" tells the agent
   * the user finished, "declined" that they will not do it. Returns false when nothing was pending.
   * Optional so other implementations (test fakes) stay valid; the terminal module implements it.
   */
  resolveUserRequest?(terminalId: string, outcome: 'done' | 'declined'): boolean;
}
