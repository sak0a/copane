// Badges on the browser's editor tabs: VS Code gives each browser editor the resource
// `vscode-browser:/<viewId>`, and tab labels consult file decorations for their resource, so a
// FileDecorationProvider for that scheme marks a tab with the session's badge ("C2") and color.
import * as vscode from 'vscode';

export const BROWSER_SCHEME = 'vscode-browser';

export function browserViewUri(viewId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BROWSER_SCHEME, path: `/${viewId}` });
}

export function viewIdOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== BROWSER_SCHEME) return undefined;
  const id = uri.path.replace(/^\//, '');
  return id || undefined;
}

export class TabDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  private readonly registration: vscode.Disposable;
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly lookup: (viewId: string) => vscode.FileDecoration | undefined) {
    this.registration = vscode.window.registerFileDecorationProvider(this);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const viewId = viewIdOf(uri);
    return viewId ? this.lookup(viewId) : undefined;
  }

  /** Asks VS Code to query the decorations of these tabs again. */
  changed(viewIds: Array<string | undefined>): void {
    const uris = viewIds.filter((v): v is string => !!v).map(browserViewUri);
    if (uris.length) this.emitter.fire(uris);
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }
}
