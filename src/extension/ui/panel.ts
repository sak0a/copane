// The Agent Tabs view in the bottom panel (next to Problems, Output, Terminal, Ports). A flat list, so
// handles are one per tab row; VS Code keeps selection and focus by `TreeItem.id` across refreshes.
import * as vscode from 'vscode';
import { TABS_VIEW_ID } from './ids';
import type { PanelModel } from './panelModel';
import type { PanelUpdate, UiState } from './state';
import { toTreeItem, type NodeHandle } from './tree';

export class TabsPanel implements vscode.TreeDataProvider<NodeHandle>, vscode.Disposable {
  private readonly handles = new Map<string, NodeHandle>();
  private readonly changeEmitter = new vscode.EventEmitter<NodeHandle | NodeHandle[] | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly view: vscode.TreeView<NodeHandle>;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly state: UiState) {
    this.view = vscode.window.createTreeView(TABS_VIEW_ID, { treeDataProvider: this });
    this.subscriptions.push(this.view, this.changeEmitter, state.onDidUpdatePanel(update => this.apply(update)));
    this.applyDescription(state.panel);
  }

  getChildren(element?: NodeHandle): NodeHandle[] {
    if (element) return [];
    return this.state.panel.roots.map(n => this.handle(n.id));
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(element: NodeHandle): vscode.TreeItem {
    const node = this.state.panel.nodes.get(element.id);
    if (!node) return new vscode.TreeItem('(gone)'); // only while a refresh is in flight
    return toTreeItem(node, undefined);
  }

  private apply(update: PanelUpdate): void {
    for (const id of [...this.handles.keys()]) if (!update.model.nodes.has(id)) this.handles.delete(id);
    if (update.full) this.changeEmitter.fire(undefined);
    else if (update.changed.length) this.changeEmitter.fire(update.changed.map(id => this.handle(id)));
    if (update.descriptionChanged) this.applyDescription(update.model);
  }

  private applyDescription(model: PanelModel): void {
    this.view.description = model.description;
  }

  private handle(id: string): NodeHandle {
    let handle = this.handles.get(id);
    if (!handle) {
      handle = Object.freeze({ id });
      this.handles.set(id, handle);
    }
    return handle;
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}
