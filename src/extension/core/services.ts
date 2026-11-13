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
  openTab(session: AgentSession, url: string, options?: { background?: boolean }): Promise<BrowserTabInfo>;
  closeTab(tabId: string): Promise<void>;
  /** Brings the tab to the front in the editor area. */
  revealTab(tabId: string): Promise<void>;
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
