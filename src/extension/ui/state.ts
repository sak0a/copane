// Keeps the current view model and rebuilds it, coalesced, whenever a session, tab, lease or terminal
// changes. Listeners only hear about updates that change something on screen.
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { Coalescer } from './coalescer';
import { buildViewModel, chromeSignature, diffModels, type UiInput, type ViewModel } from './model';
import { buildPanelModel, type PanelModel } from './panelModel';
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

/** An update of the Agent Tabs panel view. Only fired when a row or the description changed. */
export interface PanelUpdate {
  model: PanelModel;
  full: boolean;
  changed: string[];
  descriptionChanged: boolean;
}

export class UiState implements vscode.Disposable {
  private current: ViewModel;
  private currentPanel: PanelModel;
  private readonly emitter = new vscode.EventEmitter<UiUpdate>();
  private readonly panelEmitter = new vscode.EventEmitter<PanelUpdate>();
  private readonly coalescer: Coalescer;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  readonly onDidUpdate = this.emitter.event;
  readonly onDidUpdatePanel = this.panelEmitter.event;

  constructor(
    private readonly services: BridgeServices,
    readonly sources: UiSources,
  ) {
    const input = this.input();
    this.current = buildViewModel(input);
    this.currentPanel = buildPanelModel(input);
    this.coalescer = new Coalescer(() => this.rebuild());
    this.subscriptions.push(
      ...sources.subscribe(() => this.coalescer.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copane.sessionGraceSeconds')) this.coalescer.schedule();
      }),
    );
  }

  get model(): ViewModel {
    return this.current;
  }

  get panel(): PanelModel {
    return this.currentPanel;
  }

  /** Applies pending changes now, so a command acts on what is on screen and the latest state. */
  flush(): ViewModel {
    this.coalescer.flushNow();
    return this.current;
  }

  /** Like `flush`, for the panel view. */
  flushPanel(): PanelModel {
    this.coalescer.flushNow();
    return this.currentPanel;
  }

  input(): UiInput {
    return {
      sessions: this.services.sessions.list(),
      tabs: this.sources.tabs(),
      terminals: this.sources.terminals(),
      browserAvailable: this.sources.browserAvailable,
      graceSeconds: Math.max(0, vscode.workspace.getConfiguration('copane').get<number>('sessionGraceSeconds', 20)),
    };
  }

  private rebuild(): void {
    const input = this.input();
    const prev = this.current;
    const next = buildViewModel(input);
    this.current = next;
    const diff = diffModels(prev, next);
    const chromeChanged = chromeSignature(prev) !== chromeSignature(next);

    const prevPanel = this.currentPanel;
    const nextPanel = buildPanelModel(input);
    this.currentPanel = nextPanel;
    const panelDiff = diffModels(prevPanel, nextPanel);
    const descriptionChanged = prevPanel.description !== nextPanel.description;

    if (diff.full || diff.changed.length || chromeChanged) this.emitter.fire({ model: next, full: diff.full, changed: diff.changed, chromeChanged });
    if (panelDiff.full || panelDiff.changed.length || descriptionChanged) {
      this.panelEmitter.fire({ model: nextPanel, full: panelDiff.full, changed: panelDiff.changed, descriptionChanged });
    }
  }

  dispose(): void {
    this.coalescer.dispose();
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.emitter.dispose();
    this.panelEmitter.dispose();
  }
}
