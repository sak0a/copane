import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  applyTextEdits,
  argvJsonPath,
  argvState,
  disableProposedApiEdits,
  enableProposedApiEdits,
  newArgvJson,
} from '../../src/extension/registration/argv';

const ID = 'sak0a.copane';

// What VS Code writes on first start (abridged).
const DEFAULT_ARGV = `// This configuration file allows you to pass permanent command line arguments to VS Code.
//
// NOTE: Changing this file requires a restart of VS Code.
{
\t// Use software rendering instead of hardware accelerated rendering.
\t// "disable-hardware-acceleration": true,

\t// Allows to disable crash reporting.
\t"enable-crash-reporter": false,

\t// Unique id used for correlating crash reports sent from this instance.
\t// Do not edit this value.
\t"crash-reporter-id": "3fbbdbe7-0000-0000-0000-000000000000",
\t"locale": "en"
}`;

const enable = (text: string) => applyTextEdits(text, enableProposedApiEdits(text, ID));

describe('enabling the proposed API in argv.json', () => {
  it('adds the entry and keeps comments and other settings', () => {
    const next = enable(DEFAULT_ARGV);
    expect(argvState(next, ID)).toEqual({ kind: 'enabled' });
    expect(next).toContain('// Do not edit this value.');
    expect(next).toContain('\t"enable-proposed-api": [');
    const value = parse(next);
    expect(value).toMatchObject({ 'enable-crash-reporter': false, locale: 'en', 'enable-proposed-api': [ID] });
    expect(enableProposedApiEdits(next, ID)).toEqual([]);
  });

  it('extends an existing list, and turns a single string into a list', () => {
    const list = enable('{\n  "enable-proposed-api": ["other.ext"]\n}');
    expect(parse(list)['enable-proposed-api']).toEqual(['other.ext', ID]);
    const single = enable('{ "enable-proposed-api": "other.ext" }');
    expect(parse(single)['enable-proposed-api']).toEqual(['other.ext', ID]);
    expect(enableProposedApiEdits(`{ "enable-proposed-api": ["${ID.toUpperCase()}"] }`, ID)).toEqual([]);
  });

  it('refuses to edit a file it cannot parse', () => {
    expect(() => enableProposedApiEdits('{ "a": ', ID)).toThrow(/not valid/);
    expect(argvState('{ "a": ', ID)).toMatchObject({ kind: 'invalid' });
    expect(argvState(undefined, ID)).toEqual({ kind: 'missing' });
  });

  it('removes only its own id again', () => {
    const both = enable('{\n\t"enable-proposed-api": ["other.ext"]\n}');
    expect(parse(applyTextEdits(both, disableProposedApiEdits(both, ID)))['enable-proposed-api']).toEqual(['other.ext']);
    const only = enable(DEFAULT_ARGV);
    const removed = applyTextEdits(only, disableProposedApiEdits(only, ID));
    expect(parse(removed)['enable-proposed-api']).toBeUndefined();
    expect(removed).toContain('// Do not edit this value.');
  });

  it('writes a valid new file', () => {
    expect(argvState(newArgvJson(ID), ID)).toEqual({ kind: 'enabled' });
  });
});

describe('argvJsonPath', () => {
  it('uses the data folder of the running build, and the portable folder when portable', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-app-'));
    try {
      expect(argvJsonPath({ appRoot, home: '/h', env: {} })).toBe(path.join('/h', '.vscode', 'argv.json'));
      fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify({ dataFolderName: '.vscode-insiders' }));
      expect(argvJsonPath({ appRoot, home: '/h', env: {} })).toBe(path.join('/h', '.vscode-insiders', 'argv.json'));
      expect(argvJsonPath({ appRoot, home: '/h', env: { VSCODE_PORTABLE: '/p/data' } })).toBe(path.join('/p/data', 'argv.json'));
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
