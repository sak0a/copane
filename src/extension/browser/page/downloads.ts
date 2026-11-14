// Downloads that agents start in browser tabs.
//
// What VS Code does by itself (1.146): the integrated browser has no download handling of its own, so
// Electron asks the user with a native "Save As" dialog for every download, and an agent cannot learn
// where the file went. CDP's `Page.setDownloadBehavior` (through VS Code's proxy) changes that, but for
// the whole browser session (every tab, also the user's), and the setting outlives the CDP session that
// set it. So the bridge turns it on only for the short moments in which an agent acts on a tab (a
// control tool call, plus a few seconds after it) or waits for a download (browser_downloads with
// wait), saving into a private staging folder under the browser's own GUID names, and turns it back to
// "default" right after. Finished files are moved to the agent downloads folder (a setting, default
// <Downloads>/Copane) under a name that never overwrites anything. The user's own downloads keep
// VS Code's Save dialog, except in the rare case that one starts in exactly such a moment: it is then
// saved to their Downloads folder and they are told.
//
// The setting `copane.browser.agentDownloads` decides whether agents may save files at all: "ask"
// (default, once per session), "allow" (shown in the status bar) or "deny".
//
// In a remote window (WSL, SSH, containers) the extension and the agent run on the remote machine and
// the browser on the user's: a path the browser saves to is on the user's computer. There the staging
// folder is a private folder on the user's computer, and kept files are copied to the agent downloads
// folder on the remote side (downloadStaging.ts). When that folder cannot be found, downloads are not
// captured: VS Code asks the user as usual and the agent is told the file is on the user's computer.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ToolError } from '../../core/errors';
import type { BridgeServices, BrowserTabInfo, CdpPage } from '../../core/services';
import { sessionDisplayName } from '../../core/sessions';
import type { PageCall, PageHook } from './call';
import { describeDownload, isFinished, resolveDownloadsFolder, sanitizeFileName, systemDownloadsDir, type DownloadEntry } from './downloadLogic';
import { localStaging, UiStaging, type Staging } from './downloadStaging';
import type { TabInfoHost } from './emulation';

export type DownloadsSetting = 'ask' | 'allow' | 'deny';

/** How long after a control call ends downloads are still captured (a click's download often starts late). */
const TAIL_MS = 5000;
/** How long an action's result waits for a download it started to finish, so it can report the path. */
const EFFECT_WAIT_MS = 2000;
const ASK_TIMEOUT_MS = 120_000;
const REFUSAL_MEMORY_MS = 60_000;
const MAX_ENTRIES = 200;
const ARMED_KEY = 'copane.browser.downloadsArmed';

const config = () => vscode.workspace.getConfiguration('copane.browser');

export function downloadsSetting(): DownloadsSetting {
  const value = config().get<string>('agentDownloads', 'ask');
  return value === 'allow' || value === 'deny' ? value : 'ask';
}

export class DownloadManager implements PageHook, vscode.Disposable {
  private readonly entries: DownloadEntry[] = [];
  private readonly byGuid = new Map<string, DownloadEntry>();
  private nextNumber = 1;
  private readonly pages = new Map<string, CdpPage>();
  /** Where the browser saves while capturing; undefined in a remote window where no folder was found. */
  private staging: Staging | undefined;
  private stagingLookup: Promise<Staging | undefined> | undefined;
  /** Why downloads are not captured in this remote window. */
  private stagingProblem: string | undefined;
  /** Capture holds in force (control calls, waits) and the timer that ends the tail after the last one. */
  private holds = 0;
  private armed = false;
  private switching: Promise<void> = Promise.resolve();
  private disarmTimer: NodeJS.Timeout | undefined;
  private readonly allowedSessions = new Set<string>();
  private readonly refusedUntil = new Map<string, number>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private readonly decisions = new Map<string, Promise<boolean>>();
  private statusMessage: vscode.Disposable | undefined;
  private readonly changeListeners = new Set<() => void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly remoteName = vscode.env.remoteName;

  constructor(
    private readonly services: BridgeServices,
    private readonly host: TabInfoHost,
    private readonly seqOf: (tabId: string) => number,
  ) {
    this.subscriptions.push(
      services.browser.onDidAttachPage(page => this.attach(page)),
      host.addTabInfoProvider(tabId => this.tabInfo(tabId)),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        this.allowedSessions.delete(change.session.id);
        this.refusedUntil.delete(change.session.id);
      }),
    );
  }

  // ------------------------------------------------------------------ Capturing

  /** Captures downloads while a control call runs, and for a few seconds after it. */
  async aroundControl(call: PageCall): Promise<(() => void) | undefined> {
    if (!(await this.getStaging())) return undefined;
    await this.hold(call.page);
    return () => this.release(TAIL_MS);
  }

  /** The staging folder; in a remote window found once (and looked for again a minute after a failure). */
  private getStaging(): Promise<Staging | undefined> {
    if (this.staging) return Promise.resolve(this.staging);
    if (!this.remoteName) return Promise.resolve((this.staging = localStaging(readUserDirs)));
    if (!this.stagingLookup) {
      const remote = this.services.remote;
      this.stagingLookup = (remote ? UiStaging.create(remote) : Promise.resolve({ error: 'the remote module is not active' })).then(found => {
        if ('error' in found) {
          this.stagingProblem = found.error;
          this.services.log.warn(`downloads in this remote window are not captured: ${found.error}`);
          setTimeout(() => (this.stagingLookup = undefined), 60_000).unref?.();
          return undefined;
        }
        this.stagingProblem = undefined;
        this.services.log.info(`downloads are staged on the user's computer in ${found.browserPath}`);
        return (this.staging = found);
      });
    }
    return this.stagingLookup;
  }

  private async hold(page: CdpPage): Promise<void> {
    const staging = await this.getStaging();
    if (!staging) return;
    this.holds++;
    if (this.disarmTimer) {
      clearTimeout(this.disarmTimer);
      this.disarmTimer = undefined;
    }
    // Even with the setting "deny" downloads are captured (and then deleted): a download the user starts
    // in the same moment must not be refused.
    await this.serialized(async () => {
      if (this.armed) return;
      try {
        await staging.prepare();
        await page.send('Page.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: staging.browserPath }, { timeoutMs: 5000 });
        this.armed = true;
        void this.services.context.workspaceState.update(ARMED_KEY, true);
      } catch (err) {
        this.services.log.warn(`could not set the download behavior: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private release(afterMs: number): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds > 0) return;
    if (this.disarmTimer) clearTimeout(this.disarmTimer);
    this.disarmTimer = setTimeout(() => {
      this.disarmTimer = undefined;
      if (this.holds === 0) void this.disarm();
    }, afterMs);
  }

  /** Back to VS Code's own behavior (it asks the user). Sent through any tab that is still connected. */
  private disarm(): Promise<void> {
    return this.serialized(async () => {
      if (this.holds > 0 || !this.armed) return;
      for (const page of this.pages.values()) {
        if (page.closed) continue;
        try {
          await page.send('Page.setDownloadBehavior', { behavior: 'default' }, { timeoutMs: 5000 });
          this.armed = false;
          void this.services.context.workspaceState.update(ARMED_KEY, undefined);
          void this.sweepStaging();
          return;
        } catch {
          // Try the next tab.
        }
      }
      // No tab to send it through: done when the next tab attaches (see attach).
    });
  }

  /** Turning capture on and off one at a time, so a hold never sees a state that is about to change. */
  private serialized(fn: () => Promise<void>): Promise<void> {
    const next = this.switching.then(fn, fn);
    this.switching = next.catch(() => undefined);
    return next;
  }

  private attach(page: CdpPage): void {
    this.pages.set(page.tabId, page);
    page.onDidClose(() => {
      if (this.pages.get(page.tabId) === page) this.pages.delete(page.tabId);
    });
    page.on('Page.downloadWillBegin', params => this.onWillBegin(page.tabId, params));
    page.on('Page.downloadProgress', params => this.onProgress(params));
    // The behavior outlives the CDP session that set it: if it was left on (a crash, or no tab was
    // connected when it should have been turned off), turn it off now.
    if (this.holds === 0 && (this.armed || this.services.context.workspaceState.get(ARMED_KEY))) {
      this.armed = true;
      void this.disarm();
    }
  }

  // ------------------------------------------------------------------ Events

  private onWillBegin(tabId: string, p: { guid: string; url: string; suggestedFilename?: string }): void {
    if (this.byGuid.has(p.guid)) return;
    const sessionId = this.services.tabLeases.holder(tabId)?.sessionId;
    const captured = this.armed;
    const entry: DownloadEntry = {
      id: `dl-${this.nextNumber++}`,
      tabId,
      guid: p.guid,
      url: p.url,
      name: sanitizeFileName(p.suggestedFilename || lastSegment(p.url)),
      sessionId,
      seq: this.seqOf(tabId),
      startedAt: Date.now(),
      captured,
      received: 0,
      maxReceived: 0,
      total: 0,
      phase: captured ? 'downloading' : this.remoteName && !this.staging ? 'remote' : 'user-dialog',
      remoteName: this.remoteName,
      ...(this.remoteName && this.services.remote ? { remoteWhere: this.services.remote.where } : {}),
      ...(!captured && this.remoteName && !this.staging && this.stagingProblem ? { notCapturedBecause: this.stagingProblem } : {}),
    };
    this.entries.unshift(entry);
    this.byGuid.set(entry.guid, entry);
    if (this.entries.length > MAX_ENTRIES) for (const old of this.entries.splice(MAX_ENTRIES)) this.byGuid.delete(old.guid);
    this.services.log.info(`${tabId}: download ${entry.id} "${entry.name}" started (${entry.phase}${sessionId ? `, ${this.services.sessions.get(sessionId)?.label ?? sessionId}` : ''})`);
    // Ask while it downloads, so the answer is usually there when it finishes.
    if (entry.phase === 'downloading' && sessionId) this.decisions.set(entry.guid, this.decide(entry));
    this.changed();
  }

  private onProgress(p: { guid: string; totalBytes?: number; receivedBytes?: number; state?: string }): void {
    const entry = this.byGuid.get(p.guid);
    if (!entry) return;
    entry.received = p.receivedBytes ?? entry.received;
    entry.maxReceived = Math.max(entry.maxReceived, entry.received);
    if (p.totalBytes) entry.total = p.totalBytes;
    if (p.state === 'completed' && entry.endedAt === undefined) {
      entry.endedAt = Date.now();
      if (entry.phase === 'downloading') void this.finish(entry);
    } else if (p.state === 'canceled' && entry.endedAt === undefined) {
      entry.endedAt = Date.now();
      if (entry.phase === 'downloading') entry.phase = 'failed';
      else if (entry.phase === 'remote' || entry.phase === 'user-dialog') entry.reason = 'it was cancelled (by the user in the save dialog, or a network error)';
      this.decisions.delete(entry.guid);
      if (entry.captured) void this.staging?.remove(entry.guid);
    }
    this.changed();
  }

  /** The download is complete in the staging folder: keep it (if allowed) under its own name. */
  private async finish(entry: DownloadEntry): Promise<void> {
    const staging = this.staging!;
    const staged = this.remoteName ? `${staging.browserPath}${staging.browserPath.includes('\\') ? '\\' : '/'}${entry.guid} (on the user's computer)` : join(staging.browserPath, entry.guid);
    // It began just as capture was being turned off: then the browser asked the user instead.
    if (!(await staging.exists(entry.guid, 1000))) {
      entry.phase = 'user-dialog';
      entry.captured = false;
      this.decisions.delete(entry.guid);
      this.changed();
      return;
    }
    let allowed: boolean;
    if (!entry.sessionId) {
      allowed = true; // The user's own download, caught while an agent was acting: theirs to keep.
    } else {
      const decision = this.decisions.get(entry.guid) ?? this.decide(entry);
      entry.phase = 'awaiting-user';
      this.changed();
      allowed = await decision;
      this.decisions.delete(entry.guid);
    }
    if (!allowed) {
      entry.phase = downloadsSetting() === 'deny' && entry.reason?.includes('"deny"') ? 'blocked' : 'denied';
      await staging.remove(entry.guid);
      this.changed();
      return;
    }
    const target = entry.sessionId ? this.agentFolder() : { folder: undefined };
    if ('error' in target) {
      entry.phase = 'move-failed';
      entry.reason = target.error;
      entry.path = staged;
      this.changed();
      return;
    }
    try {
      entry.path = target.folder ? await staging.moveOut(entry.guid, target.folder, entry.name) : await staging.moveToUserDownloads(entry.guid, entry.name);
      entry.phase = 'saved';
      this.services.log.info(`download ${entry.id} saved to ${entry.path}`);
      this.notifySaved(entry);
    } catch (err) {
      entry.phase = 'move-failed';
      entry.reason = err instanceof Error ? err.message : String(err);
      entry.path = staged;
    }
    this.changed();
  }

  // ------------------------------------------------------------------ The user's say

  /** Whether the session's download may be kept: by setting, by an earlier answer, or by asking. */
  private decide(entry: DownloadEntry): Promise<boolean> {
    const sessionId = entry.sessionId!;
    const setting = downloadsSetting();
    if (setting === 'allow' || this.allowedSessions.has(sessionId)) return Promise.resolve(true);
    if (setting === 'deny') {
      entry.reason = 'the setting copane.browser.agentDownloads is "deny"';
      return Promise.resolve(false);
    }
    if ((this.refusedUntil.get(sessionId) ?? 0) > Date.now()) {
      entry.reason = 'the user declined downloads from you a moment ago';
      return Promise.resolve(false);
    }
    const session = this.services.sessions.get(sessionId);
    if (!session) {
      entry.reason = 'your session ended before the user allowed it';
      return Promise.resolve(false);
    }
    let pending = this.asking.get(sessionId);
    if (!pending) {
      const folder = this.agentFolder();
      const where = 'folder' in folder ? tildify(folder.folder) : 'the downloads folder';
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), ASK_TIMEOUT_MS);
      pending = this.services.prompts
        .ask({
          message: `${sessionDisplayName(session)} is downloading "${entry.name}" from ${hostOf(entry.url)}. Save it, and further downloads of this session, to ${where}?`,
          choices: ['Allow', 'Always Allow', 'Deny'],
          signal: timeout.signal,
          autoClose: true,
          placement: 'statusBar',
          summary: `${sessionDisplayName(session)} wants to download a file`,
        })
        .then(async answer => {
          if (answer === 'Always Allow') {
            try {
              await config().update('agentDownloads', 'allow', vscode.ConfigurationTarget.Global);
            } catch (err) {
              this.allowedSessions.add(sessionId);
              this.services.log.warn(`could not save copane.browser.agentDownloads: ${err instanceof Error ? err.message : String(err)}`);
            }
            return true;
          }
          if (answer === 'Allow') {
            this.allowedSessions.add(sessionId);
            return true;
          }
          this.refusedUntil.set(sessionId, Date.now() + REFUSAL_MEMORY_MS);
          return false;
        })
        .finally(() => {
          clearTimeout(timer);
          this.asking.delete(sessionId);
        });
      this.asking.set(sessionId, pending);
    }
    return pending.then(ok => {
      if (!ok && !entry.reason) entry.reason = (this.refusedUntil.get(sessionId) ?? 0) > Date.now() ? 'the user declined it (or did not answer in time)' : 'the user did not allow it';
      return ok;
    });
  }

  /**
   * Tells the user a file was saved. In the status bar, not as a notification: VS Code pauses a browser
   * view that a notification covers, which would interrupt the user and the agent.
   */
  private notifySaved(entry: DownloadEntry): void {
    const session = entry.sessionId ? this.services.sessions.get(entry.sessionId) : undefined;
    if (!session) {
      // The user's own download: in their Downloads folder (on their computer, also in a remote window).
      if (this.remoteName) {
        void vscode.window.showWarningMessage(`"${entry.name}" was saved to ${entry.path} without asking, because an agent was acting in the browser when it started.`);
        return;
      }
      void vscode.window.showWarningMessage(`"${entry.name}" was saved to ${tildify(entry.path!)} without asking, because an agent was acting in the browser when it started.`, 'Show in Folder').then(choice => {
        if (choice) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.path!));
      });
      return;
    }
    this.statusMessage?.dispose();
    const where = this.remoteName ? ` in ${this.services.remote?.where ?? 'the remote machine'}` : '';
    this.statusMessage = vscode.window.setStatusBarMessage(`$(cloud-download) ${sessionDisplayName(session)} downloaded ${entry.name} to ${tildify(entry.path!)}${where}`, 15_000);
  }

  private agentFolder(): { folder: string } | { error: string } {
    return resolveDownloadsFolder(config().get<string>('downloadsFolder', '') ?? '', {
      home: homedir(),
      downloadsDir: systemDownloadsDir(homedir(), process.platform, readUserDirs()),
      workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined,
    });
  }

  /**
   * Files in the staging folder no download of ours claims: a download started in a tab the bridge is
   * not connected to while capture was on. They are the user's; move them to their Downloads folder.
   */
  private async sweepStaging(): Promise<void> {
    const staging = this.staging;
    if (!staging) return;
    for (const { name, mtimeMs } of await staging.list()) {
      if (name.endsWith('.crdownload') || this.byGuid.has(name)) continue;
      if (Date.now() - mtimeMs < 10_000) continue; // May still be claimed by a late event.
      try {
        const saved = await staging.moveToUserDownloads(name, `download-${name.slice(0, 8)}`);
        void vscode.window.showWarningMessage(`A browser download was saved to ${this.remoteName ? saved : tildify(saved)} under a generated name, because an agent was acting in the browser when it started.`);
      } catch (err) {
        this.services.log.warn(`could not move the staged download ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ------------------------------------------------------------------ For tools

  list(tabId: string): DownloadEntry[] {
    return this.entries.filter(e => e.tabId === tabId);
  }

  get(id: string): DownloadEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  /** Lines for an action's result: downloads it started, waiting briefly for small ones to finish. */
  async effectLines(call: PageCall, sinceSeq: number): Promise<string[]> {
    const mine = () => this.entries.filter(e => e.tabId === call.tab.id && e.seq > sinceSeq);
    if (mine().length === 0) return [];
    const settled = () => mine().every(e => isFinished(e) || e.phase === 'awaiting-user' || e.phase === 'remote' || e.phase === 'user-dialog');
    await this.until(settled, EFFECT_WAIT_MS, call.signal);
    return mine()
      .reverse()
      .map(e => `Download ${describeDownload(e)}${!isFinished(e) && e.phase !== 'remote' && e.phase !== 'user-dialog' ? ' Call browser_downloads with wait: true to wait for it.' : ''}`);
  }

  /**
   * Waits for the tab's newest unfinished download, or for a new one to start and finish. Captures
   * downloads while it waits. Returns the entry, or undefined when none started in time.
   */
  async waitFor(call: PageCall, timeoutMs: number): Promise<{ entry: DownloadEntry | undefined; timedOut: boolean }> {
    const capturing = !!(await this.getStaging());
    if (capturing) await this.hold(call.page);
    try {
      const startSeq = this.seqOf(call.tab.id);
      const pick = () => this.entries.find(e => e.tabId === call.tab.id && (!isFinished(e) || e.seq > startSeq));
      const deadline = Date.now() + timeoutMs;
      const started = await this.until(() => !!pick(), timeoutMs, call.signal);
      if (!started) return { entry: undefined, timedOut: true };
      const entry = pick()!;
      const done = await this.until(() => isFinished(entry), Math.max(0, deadline - Date.now()), call.signal);
      return { entry, timedOut: !done };
    } finally {
      if (capturing) this.release(TAIL_MS);
    }
  }

  private until(check: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (check()) return resolve(true);
      if (signal.aborted) return reject(new ToolError('cancelled', 'Cancelled.'));
      const finish = (value: boolean | Error) => {
        clearTimeout(timer);
        this.changeListeners.delete(listener);
        signal.removeEventListener('abort', onAbort);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const listener = () => {
        if (check()) finish(true);
      };
      const onAbort = () => finish(new ToolError('cancelled', 'Cancelled.'));
      const timer = setTimeout(() => finish(check()), timeoutMs);
      this.changeListeners.add(listener);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private changed(): void {
    for (const listener of [...this.changeListeners]) listener();
    this.host.tabInfoChanged();
  }

  private tabInfo(tabId: string): Partial<BrowserTabInfo> | undefined {
    const mine = this.entries.filter(e => e.tabId === tabId && e.sessionId).slice(0, 5);
    if (mine.length === 0) return undefined;
    const state = (e: DownloadEntry): NonNullable<BrowserTabInfo['downloads']>[number]['state'] => {
      switch (e.phase) {
        case 'downloading':
          return 'downloading';
        case 'awaiting-user':
          return 'waiting-for-user';
        case 'saved':
          return 'saved';
        case 'denied':
        case 'blocked':
          return 'not-saved';
        case 'failed':
        case 'move-failed':
          return 'failed';
        default:
          return 'elsewhere';
      }
    };
    return {
      downloads: mine.map(e => ({
        id: e.id,
        name: e.name,
        sessionId: e.sessionId,
        state: state(e),
        progress: e.phase === 'downloading' && e.total > 0 ? Math.floor((e.maxReceived / e.total) * 100) : undefined,
        path: e.phase === 'saved' ? e.path : undefined,
      })),
    };
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.statusMessage?.dispose();
    if (this.disarmTimer) clearTimeout(this.disarmTimer);
    this.holds = 0;
    if (this.armed) void this.disarm().then(() => this.staging?.removeAll());
  }
}

function readUserDirs(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'user-dirs.dirs');
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + '/') || path.startsWith(home + '\\') ? `~${path.slice(home.length)}` : path;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || (u.protocol === 'blob:' || u.protocol === 'data:' ? 'the page itself' : url);
  } catch {
    return 'the page';
  }
}

function lastSegment(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'download';
  } catch {
    return 'download';
  }
}
