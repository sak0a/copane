// The status bar item: how many agent sessions are connected and whether one needs the user.
import * as vscode from 'vscode';
import { Cmd, STATUS_ITEM_ID } from './ids';
import type { ViewModel } from './model';
import type { UiState } from './state';

export class StatusBar implements vscode.Disposable {
  readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(state: UiState) {
    // Left side: it is about the window and workspace, not the active editor. Low priority keeps it
    // after remote, problems and ports.
    this.item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Left, -100);
    this.item.name = 'Agent Bridge';
    this.item.command = Cmd.showAttention;
    this.subscriptions.push(
      this.item,
      state.onDidUpdate(update => {
        if (update.chromeChanged || update.full) this.render(update.model);
      }),
    );
    this.render(state.model);
  }

  private render(model: ViewModel): void {
    const { status } = model;
    this.item.text = status.text;
    const tooltip = new vscode.MarkdownString(status.tooltip, true);
    tooltip.isTrusted = { enabledCommands: [Cmd.focusSessions, Cmd.showAttention] };
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = { label: status.accessibilityLabel, role: 'button' };
    this.item.backgroundColor = status.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (status.visible) this.item.show();
    else this.item.hide();
  }

  /** What is currently shown, for the dev-only `debug_ui_state` tool. */
  snapshot(): { text: string; backgroundColor: string | undefined; accessibilityLabel: string | undefined; command: string | undefined } {
    return {
      text: this.item.text,
      backgroundColor: this.item.backgroundColor instanceof vscode.ThemeColor ? (this.item.backgroundColor as unknown as { id: string }).id : undefined,
      accessibilityLabel: this.item.accessibilityInformation?.label,
      command: typeof this.item.command === 'string' ? this.item.command : this.item.command?.command,
    };
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}
