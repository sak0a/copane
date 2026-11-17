import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentsSetup,
  browserSetup,
  setupContext,
  shouldOpenWalkthrough,
  stepStates,
  TRY_IT_PROMPT,
  unsupportedBrowserText,
  WALKTHROUGH_ID,
  type SetupContext,
} from '../../src/extension/registration/setup';
import { renderStatus } from '../../src/extension/registration/status';

const root = join(__dirname, '..', '..');
const ours = { kind: 'ours', current: true, command: '/h/bin/mcp-server' } as const;

describe('browserSetup', () => {
  const base = { available: false, remote: false, argv: undefined, integratedBrowser: true };
  it('is ready whenever the API is available', () => {
    expect(browserSetup({ ...base, available: true, remote: true })).toBe('ready');
  });
  it('says what is missing in a local window', () => {
    expect(browserSetup({ ...base, argv: { kind: 'not-enabled' } })).toBe('off');
    expect(browserSetup({ ...base, argv: { kind: 'missing' } })).toBe('off');
    expect(browserSetup({ ...base, argv: { kind: 'enabled' } })).toBe('restart');
  });
  it('is partly manual in a remote window, where argv.json is not readable', () => {
    expect(browserSetup({ ...base, remote: true })).toBe('remote');
  });
  it('offers nothing to enable in an editor without the integrated browser', () => {
    expect(browserSetup({ ...base, integratedBrowser: false, argv: { kind: 'enabled' } })).toBe('unsupported');
    expect(browserSetup({ ...base, integratedBrowser: false, remote: true })).toBe('unsupported');
  });
});

describe('agentsSetup', () => {
  it('is ready when one enabled agent has our entry, even an outdated one', () => {
    expect(agentsSetup([{ enabled: true, detected: true, state: { kind: 'absent' } }, { enabled: true, detected: true, state: ours }])).toBe('ready');
    expect(agentsSetup([{ enabled: true, detected: true, state: { ...ours, current: false } }])).toBe('ready');
  });
  it('ignores agents turned off in settings', () => {
    expect(agentsSetup([{ enabled: false, detected: true, state: ours }])).toBe('none');
  });
  it('tells "installed but off" from "nothing installed"', () => {
    expect(agentsSetup([{ enabled: true, detected: true, state: { kind: 'foreign', command: 'x' } }])).toBe('off');
    expect(agentsSetup([{ enabled: true, detected: false, state: { kind: 'absent' } }])).toBe('none');
  });
  it('counts GitHub Copilot like the other agents (three agents, only Copilot registered)', () => {
    const absent = { enabled: true, detected: true, state: { kind: 'absent' } } as const;
    expect(agentsSetup([absent, absent, { enabled: true, detected: true, state: ours }])).toBe('ready');
    expect(agentsSetup([{ ...absent, detected: false }, { ...absent, detected: false }, absent])).toBe('off');
    expect(agentsSetup([{ ...absent, detected: false }, { ...absent, detected: false }, { enabled: false, detected: true, state: ours }])).toBe('none');
  });
});

describe('setupContext and the first-run walkthrough', () => {
  it('is done with the browser and an agent, or with an agent where no browser exists', () => {
    expect(setupContext('ready', 'ready', false)['copane.setup.done']).toBe(true);
    expect(setupContext('unsupported', 'ready', false)['copane.setup.done']).toBe(true);
    expect(setupContext('restart', 'ready', true)['copane.setup.done']).toBe(false);
    expect(setupContext('ready', 'off', true)['copane.setup.done']).toBe(false);
  });
  it('opens once, only while something is left to do, never in a development host', () => {
    const todo = setupContext('off', 'off', false);
    const done = setupContext('ready', 'ready', true);
    expect(shouldOpenWalkthrough({ alreadyOpened: false, context: todo, development: false })).toBe(true);
    expect(shouldOpenWalkthrough({ alreadyOpened: true, context: todo, development: false })).toBe(false);
    expect(shouldOpenWalkthrough({ alreadyOpened: false, context: done, development: false })).toBe(false);
    expect(shouldOpenWalkthrough({ alreadyOpened: false, context: todo, development: true })).toBe(false);
  });
  it('checks steps from the state, and un-checks them when it changes back', () => {
    expect(stepStates(setupContext('ready', 'off', false))).toMatchObject({ browser: true, browserRestart: true, agents: false, tryIt: false });
    expect(stepStates(setupContext('unsupported', 'ready', true))).toMatchObject({ browserUnsupported: true, agents: true, agentsNone: true, tryIt: true });
    expect(stepStates(setupContext('off', 'off', false)).browser).toBe(false);
  });
});

describe('contributes/walkthrough.json', () => {
  const fragment = JSON.parse(readFileSync(join(root, 'contributes', 'walkthrough.json'), 'utf8'));
  const walkthrough = fragment.walkthroughs.find((w: { id: string }) => w.id === WALKTHROUGH_ID);
  const steps: Array<{ id: string; description: string; when?: string; completionEvents?: string[]; media: { svg?: string; altText: string } }> = walkthrough.steps;
  const keys = Object.keys(setupContext('ready', 'ready', true)) as Array<keyof SetupContext>;

  it('has the steps the setup state checks off, and media that exists', () => {
    for (const id of Object.keys(stepStates(setupContext('ready', 'ready', true)))) expect(steps.map(s => s.id)).toContain(id);
    for (const step of steps) {
      expect(step.media.altText.length, step.id).toBeGreaterThan(20);
      if (step.media.svg) expect(existsSync(join(root, step.media.svg)), step.media.svg).toBe(true);
    }
  });

  it('completes and selects steps only on context keys that setup.ts sets', () => {
    for (const step of steps) {
      for (const event of step.completionEvents ?? []) {
        if (event.startsWith('onContext:')) expect(keys).toContain(event.slice('onContext:'.length));
      }
      for (const key of step.when?.match(/copane\.setup\.[a-zA-Z.]+/g) ?? []) expect(keys).toContain(key);
    }
  });

  it('shows the prompt that "Copy Prompt" copies', () => {
    const tryIt = steps.find(s => s.id === 'tryIt')!;
    expect(tryIt.description).toContain(TRY_IT_PROMPT);
    expect(tryIt.description).toContain('command:copane.walkthrough.copyPrompt');
  });

  it('uses theme colors in its SVGs, as attributes (the walkthrough webview allows no <style>)', () => {
    for (const step of steps) {
      if (!step.media.svg) continue;
      const svg = readFileSync(join(root, step.media.svg), 'utf8');
      expect(svg, step.media.svg).not.toContain('<style');
      expect(svg, step.media.svg).toContain('var(--vscode-foreground');
    }
  });
});

describe('status report in an editor without the integrated browser', () => {
  it('says it is not supported instead of offering a fix', () => {
    const text = renderStatus({
      generatedAt: new Date('2026-11-13T00:00:00Z'),
      extensionVersion: '0.2.1',
      vscode: { appName: 'Some Editor', version: '1.141.0', remoteName: null, platform: 'darwin', arch: 'arm64' },
      window: { id: '1', socketPath: '/s', listening: true, instanceFile: '/i', instanceFilePresent: true, workspaceName: null, folders: [] },
      otherWindows: [],
      bridgeHome: '/h',
      browser: { available: false, argvPath: '/u/.x/argv.json', argvState: { kind: 'missing' }, remote: false, unsupported: unsupportedBrowserText('Some Editor', '1.141.0') },
      server: { spec: { command: '/h/bin/mcp-server', args: [], env: {} }, installedVersion: '0.2.1', runtimes: [], selfTest: { ok: true, text: 'ok' } },
      registrationMode: 'ask',
      consent: 'not asked yet',
      agents: [],
      sessions: [],
    });
    expect(text).toContain('Browser API: not supported in this editor. Some Editor 1.141.0 has no integrated browser');
    expect(text).not.toContain('Run "Copane: Enable Integrated Browser"');
    expect(text).not.toContain('argv.json: /u/.x/argv.json');
  });
});
