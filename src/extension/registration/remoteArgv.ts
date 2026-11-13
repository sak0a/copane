// argv.json from a remote window (WSL, SSH, containers). It is on the user's machine, which this
// extension host reaches through vscode.workspace.fs (scheme vscode-local, see remote/uiSide.ts), so
// it is read and changed there directly, like the local file in a local window.
import * as vscode from 'vscode';
import type { RemoteService } from '../core/services';
import { applyTextEdits, argvState, enableProposedApiEdits, newArgvJson, type ArgvState } from './argv';

export interface UiArgvResult {
  /** As the user's machine writes it, for messages. */
  file: string;
  uri: vscode.Uri;
  changed: boolean;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
    throw err;
  }
}

/** Adds the extension to enable-proposed-api in the user's argv.json. Throws when the file cannot be read or written. */
export async function enableInUiArgv(remote: RemoteService, extensionId: string): Promise<UiArgvResult | { error: string }> {
  const target = await remote.uiArgvJson();
  if ('error' in target) return target;
  const text = await readText(target.uri);
  let next: string | undefined;
  if (text === undefined) next = newArgvJson(extensionId);
  else {
    const edits = enableProposedApiEdits(text, extensionId);
    if (edits.length > 0) next = applyTextEdits(text, edits);
  }
  if (next !== undefined) await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(next));
  return { file: target.nativePath, uri: target.uri, changed: next !== undefined };
}

/** Whether the user's argv.json enables the extension, when the file can be found. */
export async function uiArgvState(remote: RemoteService, extensionId: string): Promise<{ file: string; uri: vscode.Uri; state: ArgvState } | undefined> {
  const target = await remote.uiArgvJson();
  if ('error' in target) return undefined;
  try {
    return { file: target.nativePath, uri: target.uri, state: argvState(await readText(target.uri), extensionId) };
  } catch {
    return undefined;
  }
}
