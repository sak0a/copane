// Certificate errors (self-signed, company CA not in the system store, wrong host name) in tabs an
// agent session is driving. VS Code shows the user an error page with "Proceed anyway"; an agent
// cannot click that, so while a session controls a tab the bridge decides instead: hosts the user
// listed in the settings pass, anything else asks the user once per host. Nothing is ever accepted
// silently for a host the user has not approved, and tabs no agent controls are left to VS Code.
import * as vscode from 'vscode';
import type { BridgeServices, CdpPage } from '../core/services';
import { sessionDisplayName } from '../core/sessions';

/** `patterns`: exact host names, or `*.example.com` for a domain and all its subdomains. Case-insensitive. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some(raw => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p;
  });
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Plain words for the common Chromium certificate error codes. */
export function describeCertError(errorType: string): string {
  if (/AUTHORITY_INVALID/.test(errorType)) return 'it is self-signed or issued by an authority this computer does not trust';
  if (/COMMON_NAME_INVALID/.test(errorType)) return 'it was issued for a different host name';
  if (/DATE_INVALID/.test(errorType)) return 'it has expired or is not valid yet';
  if (/REVOKED/.test(errorType)) return 'it has been revoked';
  if (/WEAK|INSECURE/.test(errorType)) return 'it uses weak cryptography';
  return `the browser reports ${errorType.replace(/^net::/, '')}`;
}

const ASK_TIMEOUT_MS = 90_000;
const REFUSAL_MEMORY_MS = 60_000;

export class CertificateGate implements vscode.Disposable {
  private readonly pages = new Map<string, CdpPage>();
  private readonly overriding = new Set<CdpPage>();
  /** Hosts the user accepted with "Proceed" in this window (not persisted). */
  private readonly acceptedOnce = new Set<string>();
  private readonly refusedUntil = new Map<string, number>();
  /** Why the last certificate error of a host was refused, for the agent's error message. */
  private readonly refusals = new Map<string, { reason: string; at: number }>();
  private readonly asking = new Map<string, Promise<boolean>>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly services: BridgeServices) {
    this.subscriptions.push(
      services.browser.onDidAttachPage(page => this.attach(page)),
      services.tabLeases.onDidChange(change => void this.sync(change.resourceId)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('agentBridge.browser.certificateErrors')) for (const id of this.pages.keys()) void this.sync(id);
      }),
    );
  }

  private get mode(): 'ask' | 'block' {
    return vscode.workspace.getConfiguration('agentBridge.browser').get<'ask' | 'block'>('certificateErrors', 'ask');
  }

  private get trustedHosts(): string[] {
    return vscode.workspace.getConfiguration('agentBridge.browser').get<string[]>('trustedCertificateHosts', []);
  }

  private attach(page: CdpPage): void {
    this.pages.set(page.tabId, page);
    page.on('Security.certificateError', params => void this.onError(page, params));
    page.onDidClose(() => {
      this.overriding.delete(page);
      if (this.pages.get(page.tabId) === page) this.pages.delete(page.tabId);
    });
    void this.sync(page.tabId);
  }

  /** Certificate errors are routed to the bridge only while a session controls the tab. */
  private async sync(tabId: string): Promise<void> {
    const page = this.pages.get(tabId);
    if (!page || page.closed) return;
    const want = this.mode !== 'block' && !!this.services.tabLeases.holder(tabId);
    if (want === this.overriding.has(page)) return;
    try {
      if (want) {
        this.overriding.add(page);
        await page.send('Security.enable');
        await page.send('Security.setOverrideCertificateErrors', { override: true });
      } else {
        this.overriding.delete(page);
        await page.send('Security.setOverrideCertificateErrors', { override: false });
      }
    } catch (err) {
      this.overriding.delete(page);
      this.services.log.warn(`${tabId}: certificate handling could not be ${want ? 'enabled' : 'disabled'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** See `BrowserService.certificateRefusal`. */
  refusalFor(url: string): string | undefined {
    const host = hostOf(url);
    const refusal = host ? this.refusals.get(host) : undefined;
    return refusal && Date.now() - refusal.at < 30_000 ? refusal.reason : undefined;
  }

  private async onError(page: CdpPage, params: { eventId: number; errorType: string; requestURL: string }): Promise<void> {
    let proceed = false;
    try {
      proceed = await this.decide(page.tabId, params);
      const host = hostOf(params.requestURL);
      if (host && proceed) this.refusals.delete(host);
    } catch (err) {
      this.services.log.warn(`${page.tabId}: certificate decision failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Every event must be answered, or the request hangs.
    await page.send('Security.handleCertificateError', { eventId: params.eventId, action: proceed ? 'continue' : 'cancel' }).then(undefined, () => {});
  }

  private async decide(tabId: string, params: { errorType: string; requestURL: string }): Promise<boolean> {
    const host = hostOf(params.requestURL);
    if (!host) return false;
    const refuse = (reason: string) => {
      this.refusals.set(host, { reason, at: Date.now() });
      return false;
    };
    if (this.mode === 'block') return refuse('the setting for certificate errors is "block"');
    if (hostMatches(host, this.trustedHosts) || this.acceptedOnce.has(host)) return true;
    if ((this.refusedUntil.get(host) ?? 0) > Date.now()) return refuse('the user was asked a moment ago and did not approve it');
    const holder = this.services.tabLeases.holder(tabId);
    const session = holder && this.services.sessions.get(holder.sessionId);
    if (!session) return false;

    let pending = this.asking.get(host);
    if (!pending) {
      const always = `Always Trust ${host}`;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), ASK_TIMEOUT_MS);
      pending = this.services.prompts
        .ask({
          message: `${sessionDisplayName(session)} is opening ${host}, whose security certificate is not trusted: ${describeCertError(params.errorType)}. Proceed anyway? Only do this for sites you know, such as local or company servers.`,
          choices: ['Proceed', always, 'Cancel'],
          signal: timeout.signal,
          autoClose: true,
        })
        .then(async answer => {
          if (answer === always) {
            const config = vscode.workspace.getConfiguration('agentBridge.browser');
            const current = config.get<string[]>('trustedCertificateHosts', []);
            if (!hostMatches(host, current)) await config.update('trustedCertificateHosts', [...current, host], vscode.ConfigurationTarget.Global);
            this.services.log.info(`certificate for ${host} is now always trusted (${params.errorType})`);
            return true;
          }
          if (answer === 'Proceed') {
            this.acceptedOnce.add(host);
            this.services.log.info(`certificate for ${host} accepted until this window closes (${params.errorType})`);
            return true;
          }
          this.refusedUntil.set(host, Date.now() + REFUSAL_MEMORY_MS);
          refuse(answer === 'Cancel' ? 'the user declined' : 'the user did not answer');
          this.services.log.info(`certificate for ${host} not accepted (${answer ?? 'no answer'})`);
          return false;
        })
        .finally(() => {
          clearTimeout(timer);
          this.asking.delete(host);
        });
      this.asking.set(host, pending);
    }
    return pending;
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.pages.clear();
  }
}
