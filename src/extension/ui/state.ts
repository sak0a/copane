// Keeps the current view model and rebuilds it, coalesced, whenever a session, tab, lease or terminal
// changes. Listeners only hear about updates that change something on screen.
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { Coalescer } from './coalescer';
import { buildViewModel, chromeSignature, diffModels, type UiInput, type ViewModel } from './model';
import type { UiSources } from './sources';

export interface UiUpdate {
  model: ViewModel;
  /** The tree must be refreshed from the root. */
  full: boolean;
  /** Ids of tree nodes whose row or children changed. */
  changed: string[];
  /** Status bar, badge, view description or attention list changed. */
  chromeChanged: boolean;
}

export class UiState implements vscode.Disposable {
  private current: ViewModel;
  private readonly emitter = new vscode.EventEmitter<UiUpdate>();
  private readonly coalescer: Coalescer;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  readonly onDidUpdate = this.emitter.event;

  constructor(
    private readonly services: BridgeServices,
    readonly sources: UiSources,
  ) {
    this.current = buildViewModel(this.input());
    this.coalescer = new Coalescer(() => this.rebuild());
    this.subscriptions.push(
      ...sources.subscribe(() => this.coalescer.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('agentBridge.sessionGraceSeconds')) this.coalescer.schedule();
      }),
    );
  }

  get model(): ViewModel {
    return this.current;
  }

  /** Applies pending changes now, so a command acts on what is on screen and the latest state. */
  flush(): ViewModel {
    this.coalescer.flushNow();
    return this.current;
  }

  input(): UiInput {
    return {
      sessions: this.services.sessions.list(),
      tabs: this.sources.tabs(),
      terminals: this.sources.terminals(),
      browserAvailable: this.sources.browserAvailable,
      graceSeconds: Math.max(0, vscode.workspace.getConfiguration('agentBridge').get<number>('sessionGraceSeconds', 20)),
    };
  }

  private rebuild(): void {
    const prev = this.current;
    const next = buildViewModel(this.input());
    this.current = next;
    const diff = diffModels(prev, next);
    const chromeChanged = chromeSignature(prev) !== chromeSignature(next);
    if (!diff.full && diff.changed.length === 0 && !chromeChanged) return;
    this.emitter.fire({ model: next, full: diff.full, changed: diff.changed, chromeChanged });
  }

  dispose(): void {
    this.coalescer.dispose();
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.emitter.dispose();
  }
}
