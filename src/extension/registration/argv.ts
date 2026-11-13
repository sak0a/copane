// Enabling the proposed `browser` API: VS Code reads `"enable-proposed-api": ["<extension id>"]` from
// its argv.json at startup (`code --enable-proposed-api <id>` does the same for one launch).
//
// argv.json lives in the home folder of the machine that runs VS Code's UI, in the build's data folder
// (`~/.vscode` for Stable, `~/.vscode-insiders` for Insiders, `~/.vscode-oss` for OSS builds, from
// product.json `dataFolderName`), or in `$VSCODE_PORTABLE/argv.json` for a portable install. VS Code
// opens the same file with the command "Preferences: Configure Runtime Arguments".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

export const PROPOSED_API_KEY = 'enable-proposed-api';

/** The argv.json of the VS Code build whose application folder is `appRoot` (local windows only). */
export function argvJsonPath(options: { appRoot: string; home: string; env: NodeJS.ProcessEnv }): string {
  if (options.env.VSCODE_PORTABLE) return path.join(options.env.VSCODE_PORTABLE, 'argv.json');
  let dataFolderName = '.vscode';
  try {
    const product = JSON.parse(fs.readFileSync(path.join(options.appRoot, 'product.json'), 'utf8'));
    if (typeof product.dataFolderName === 'string' && product.dataFolderName) dataFolderName = product.dataFolderName;
  } catch {
    // Keep the Stable default.
  }
  return path.join(options.home, dataFolderName, 'argv.json');
}

export type ArgvState =
  | { kind: 'enabled' }
  | { kind: 'not-enabled' }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string };

export function argvState(text: string | undefined, extensionId: string): ArgvState {
  if (text === undefined) return { kind: 'missing' };
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', error: 'argv.json is not valid JSON with comments' };
  return listOf(value[PROPOSED_API_KEY]).some(id => sameId(id, extensionId)) ? { kind: 'enabled' } : { kind: 'not-enabled' };
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface TextEdit {
  offset: number;
  length: number;
  content: string;
}

/**
 * The edits that add `extensionId` to `enable-proposed-api`, keeping comments, formatting and other
 * entries. An existing list is extended; a single string becomes a list with both; nothing is
 * changed when the id is already there. Throws when the text is not valid JSONC (we never rewrite a
 * file we cannot read).
 */
export function enableProposedApiEdits(text: string, extensionId: string): TextEdit[] {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('argv.json is not valid JSON with comments; fix or remove it first');
  }
  const current = value[PROPOSED_API_KEY];
  const ids = listOf(current);
  if (ids.some(id => sameId(id, extensionId))) return [];
  const formattingOptions = detectFormatting(text);
  if (Array.isArray(current)) {
    return modify(text, [PROPOSED_API_KEY, -1], extensionId, { formattingOptions, isArrayInsertion: true });
  }
  return modify(text, [PROPOSED_API_KEY], [...ids, extensionId], { formattingOptions });
}

/** The edits that remove `extensionId` again (other ids stay). */
export function disableProposedApiEdits(text: string, extensionId: string): TextEdit[] {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value !== 'object') throw new Error('argv.json is not valid JSON with comments');
  const current = value[PROPOSED_API_KEY];
  const formattingOptions = detectFormatting(text);
  if (Array.isArray(current)) {
    const index = current.findIndex(v => typeof v === 'string' && sameId(v, extensionId));
    if (index < 0) return [];
    if (current.length === 1) return modify(text, [PROPOSED_API_KEY], undefined, { formattingOptions });
    return modify(text, [PROPOSED_API_KEY, index], undefined, { formattingOptions });
  }
  if (typeof current === 'string' && sameId(current, extensionId)) return modify(text, [PROPOSED_API_KEY], undefined, { formattingOptions });
  return [];
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  return applyEdits(text, edits);
}

/** The content of a new argv.json with only our entry. */
export function newArgvJson(extensionId: string): string {
  return [
    '// This configuration file allows you to pass permanent command line arguments to VS Code.',
    '// Changing this file requires a restart of VS Code.',
    '{',
    `\t// Lets the Agent Bridge extension use VS Code's integrated browser (proposed API).`,
    `\t"${PROPOSED_API_KEY}": [${JSON.stringify(extensionId)}]`,
    '}',
    '',
  ].join('\n');
}

function detectFormatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '\t';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 4, eol } : { insertSpaces: true, tabSize: indent.length, eol };
}
