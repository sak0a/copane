// The Sessions tree view. Elements are small handle objects, one per node id and kept for as long as
// the node exists, so VS Code can refresh single rows and keeps expansion and selection across updates.
import * as vscode from 'vscode';
import { ContextKey, SESSIONS_VIEW_ID } from './ids';
import type { ViewModel, ViewNode } from './model';
import type { UiState, UiUpdate } from './state';

export interface NodeHandle {
  readonly id: string;
}

export class SessionsTree implements vscode.TreeDataProvider<NodeHandle>, vscode.Disposable {
  private readonly handles = new Map<string, NodeHandle>();
  /** Expansion the user chose, by node id. Sessions start expanded. */
  private readonly expanded = new Map<string, boolean>();
  private readonly changeEmitter = new vscode.EventEmitter<NodeHandle | NodeHandle[] | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly view: vscode.TreeView<NodeHandle>;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly state: UiState) {
    this.view = vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
    this.subscriptions.push(
      this.view,
      this.changeEmitter,
      this.view.onDidExpandElement(e => this.expanded.set(e.element.id, true)),
      this.view.onDidCollapseElement(e => this.expanded.set(e.element.id, false)),
      state.onDidUpdate(update => this.apply(update)),
    );
    this.applyChrome(state.model);
  }

  getChildren(element?: NodeHandle): NodeHandle[] {
    const model = this.state.model;
    const nodes = element ? (model.nodes.get(element.id)?.children ?? []) : model.roots;
    return nodes.map(n => this.handle(n.id));
  }

  getParent(element: NodeHandle): NodeHandle | undefined {
    const parent = this.state.model.parents.get(element.id);
    return parent ? this.handle(parent) : undefined;
  }

  getTreeItem(element: NodeHandle): vscode.TreeItem {
    const node = this.state.model.nodes.get(element.id);
    if (!node) return new vscode.TreeItem('(gone)'); // only while a refresh is in flight
    return toTreeItem(node, node.children.length ? (this.expanded.get(node.id) ?? true) : undefined);
  }

  /** Selects and reveals the row of a node, e.g. after the user picked it from the status bar. */
  async reveal(nodeId: string, options: { focus?: boolean } = {}): Promise<void> {
    if (!this.state.model.nodes.has(nodeId)) return;
    const handle = this.handle(nodeId);
    const reveal = () => this.view.reveal(handle, { select: true, focus: options.focus ?? false, expand: true });
    await reveal();
    // A view that is just opening, or refreshing its rows, can drop the selection again.
    for (let i = 0; i < 4 && !this.view.selection.includes(handle); i++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!this.state.model.nodes.has(nodeId)) return;
      if (!this.view.selection.includes(handle)) await reveal();
    }
  }

  private apply(update: UiUpdate): void {
    for (const id of [...this.handles.keys()]) if (!update.model.nodes.has(id)) this.handles.delete(id);
    if (update.full) this.changeEmitter.fire(undefined);
    else if (update.changed.length) this.changeEmitter.fire(update.changed.map(id => this.handle(id)));
    if (update.chromeChanged || update.full) this.applyChrome(update.model);
  }

  private applyChrome(model: ViewModel): void {
    this.view.badge = model.badge;
    this.view.description = model.viewDescription;
    void vscode.commands.executeCommand('setContext', ContextKey.hasSessions, model.status.visible);
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

export function toTreeItem(node: ViewNode, expanded: boolean | undefined): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    expanded === undefined ? vscode.TreeItemCollapsibleState.None : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = node.id;
  item.description = node.description;
  const tooltip = new vscode.MarkdownString(node.tooltip, true);
  item.tooltip = tooltip;
  item.iconPath = new vscode.ThemeIcon(node.icon.id, node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined);
  item.contextValue = node.contextValue;
  item.accessibilityInformation = { label: node.accessibilityLabel };
  if (node.command) item.command = { command: node.command.command, title: node.command.title, arguments: node.command.args };
  return item;
}
