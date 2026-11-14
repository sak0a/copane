// Turns the steps the recorder kept for one tab (recorder.ts) into a Playwright test (`@playwright/test`,
// TypeScript). Pure, so the generated code is unit-tested directly. Secrets typed into password fields
// never reach a step: the recorder stores only the name of an environment variable for them.
import { keyDefinition } from './keys';
import { quote, renderLocator, selectorChain, type LocatorChain } from './locatorLogic';

/** What an action acted on: a locator chosen at the time of the action, or viewport coordinates. */
export type StepTarget =
  | { locator: LocatorChain; robust: boolean; label: string }
  | { point: { x: number; y: number }; label: string };

/** A value typed into a secret field: only the environment variable that will hold it. */
export interface Secret {
  env: string;
}
export type Text = string | Secret;

export type Step =
  | { kind: 'goto'; url: string }
  | { kind: 'history'; action: 'back' | 'forward' | 'reload' }
  | { kind: 'click'; target: StepTarget; button?: 'left' | 'right' | 'middle'; double?: boolean; modifiers?: string[] }
  | { kind: 'fill'; target: StepTarget; value: Text }
  | { kind: 'type'; target?: StepTarget; value: Text; append?: boolean; slowly?: boolean; submit?: boolean }
  | { kind: 'check'; target: StepTarget; checked: boolean }
  | { kind: 'select'; target: StepTarget; values: string[] }
  | { kind: 'press'; target?: StepTarget; key: string; count: number }
  | { kind: 'hover'; target: StepTarget }
  | { kind: 'scroll'; target?: StepTarget; dx: number; dy: number }
  | { kind: 'drag'; from: StepTarget; to: StepTarget }
  | { kind: 'upload'; target: StepTarget; files: string[]; chooser: boolean }
  | { kind: 'dialog'; accept: boolean; promptText?: string }
  | { kind: 'expectText'; text: string; gone?: boolean; frames?: string[] }
  | { kind: 'expectSelector'; selector: string; state: 'visible' | 'hidden' | 'attached' | 'detached'; frames?: string[] }
  | { kind: 'expectUrl'; url: string }
  | { kind: 'expectUrlPattern'; pattern: string }
  | { kind: 'waitLoad'; state: 'domcontentloaded' | 'load' | 'networkidle' }
  | { kind: 'waitTime'; ms: number }
  | { kind: 'note'; text: string };

export interface TestSource {
  name: string;
  /** URL the tab showed when the recording started (used when the first step is not a navigation). */
  startUrl: string;
  steps: Step[];
  /** Steps dropped from the start because the recording grew too long. */
  dropped?: number;
}

export interface GeneratedTest {
  code: string;
  /** Environment variables the test reads (secrets the recording did not keep). */
  env: string[];
  /** Steps that do not replay robustly (coordinates, index-based locators, left-out tool calls). */
  warnings: string[];
  steps: number;
}

const isSecret = (t: Text): t is Secret => typeof t !== 'string';
const textCode = (t: Text) => (isSecret(t) ? `process.env.${t.env}!` : quote(t));

/** A key or chord as Playwright names it ("Control+a", "ControlOrMeta+Enter", "Space"). */
export function playwrightKey(chord: string): string {
  const value = chord.trim() === '' && chord.length > 0 ? ' ' : chord.trim();
  const parts = value === '+' ? ['+'] : value.endsWith('++') ? [...value.slice(0, -2).split('+'), '+'] : value.split('+');
  const key = parts.pop()!;
  const mods: Record<string, string> = { ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', controlormeta: 'ControlOrMeta', mod: 'ControlOrMeta' };
  const out = parts.map(p => mods[p.toLowerCase()] ?? p);
  const named = mods[key.toLowerCase()] ?? keyDefinition(key)?.key ?? key;
  out.push(named === ' ' ? 'Space' : named);
  return out.join('+');
}

/** A regular expression literal that matches `s` literally. */
function regexLiteral(s: string): string {
  return `/${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`;
}

/** URLs with long query strings carry state (tokens, ids) that differs between runs: assert the path only. */
function urlAssertion(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return quote(url);
  }
  if (u.search.length <= 40) return quote(url);
  return regexLiteral(`${u.origin}${u.pathname}`);
}

/** A copane URL pattern of browser_wait_for (substring, glob with *, or /regex/) as a toHaveURL argument. */
export function urlPatternCode(pattern: string): string {
  if (/^\/.+\/[a-z]*$/.test(pattern)) return pattern;
  if (pattern.includes('*')) return `/^${pattern.replace(/\*+/g, '*').split('*').map(s => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$/`;
  return regexLiteral(pattern);
}

function point(t: StepTarget): { x: number; y: number } | undefined {
  return 'point' in t ? t.point : undefined;
}

function loc(t: StepTarget): string {
  return 'locator' in t ? renderLocator(t.locator) : 'page';
}

const round = (n: number) => Math.round(n);

/** Lines of the test body for one step (no indentation), and warnings it raises. */
function stepLines(step: Step, warn: (w: string) => void, n: number): string[] {
  const coordinates = (t: StepTarget) => warn(`step ${n} acted on coordinates (${t.label}), which break when the layout changes; replace them with a locator`);
  switch (step.kind) {
    case 'goto':
      return [`await page.goto(${quote(step.url)});`];
    case 'history':
      return [`await page.${step.action === 'back' ? 'goBack' : step.action === 'forward' ? 'goForward' : 'reload'}();`];
    case 'click': {
      const p = point(step.target);
      const opts = [step.button && step.button !== 'left' ? `button: ${quote(step.button)}` : '', step.modifiers?.length ? `modifiers: [${step.modifiers.map(m => quote(m)).join(', ')}]` : ''].filter(Boolean);
      if (p) {
        coordinates(step.target);
        const mouseOpts = [step.button && step.button !== 'left' ? `button: ${quote(step.button)}` : '', step.double ? 'clickCount: 2' : ''].filter(Boolean);
        const mods = step.modifiers ?? [];
        return [
          `// Coordinates: replace with a locator.`,
          ...mods.map(m => `await page.keyboard.down(${quote(m)});`),
          `await page.mouse.click(${round(p.x)}, ${round(p.y)}${mouseOpts.length ? `, { ${mouseOpts.join(', ')} }` : ''});`,
          ...[...mods].reverse().map(m => `await page.keyboard.up(${quote(m)});`),
        ];
      }
      return [`await ${loc(step.target)}.${step.double ? 'dblclick' : 'click'}(${opts.length ? `{ ${opts.join(', ')} }` : ''});`];
    }
    case 'fill':
      return [`await ${loc(step.target)}.fill(${textCode(step.value)});`];
    case 'type': {
      const lines: string[] = [];
      if (!step.target) lines.push(`await page.keyboard.type(${textCode(step.value)});`);
      else if (step.append || step.slowly) {
        // One key event per character, as the agent typed it (key handlers, search-as-you-type).
        lines.push(step.append ? `await ${loc(step.target)}.press('End');` : `await ${loc(step.target)}.clear();`, `await ${loc(step.target)}.pressSequentially(${textCode(step.value)});`);
      } else lines.push(`await ${loc(step.target)}.fill(${textCode(step.value)});`);
      if (step.submit) lines.push(step.target ? `await ${loc(step.target)}.press('Enter');` : `await page.keyboard.press('Enter');`);
      return lines;
    }
    case 'check':
      return [`await ${loc(step.target)}.${step.checked ? 'check' : 'uncheck'}();`];
    case 'select':
      return [`await ${loc(step.target)}.selectOption(${step.values.length === 1 ? quote(step.values[0]!) : `[${step.values.map(v => quote(v)).join(', ')}]`});`];
    case 'press': {
      const key = quote(playwrightKey(step.key));
      const call = step.target ? `await ${loc(step.target)}.press(${key});` : `await page.keyboard.press(${key});`;
      return step.count > 1 ? [`for (let i = 0; i < ${step.count}; i++) ${call}`] : [call];
    }
    case 'hover': {
      const p = point(step.target);
      if (p) {
        coordinates(step.target);
        return [`await page.mouse.move(${round(p.x)}, ${round(p.y)}); // coordinates: replace with a locator`];
      }
      return [`await ${loc(step.target)}.hover();`];
    }
    case 'scroll':
      if (step.target && step.dx === 0 && step.dy === 0) return [`await ${loc(step.target)}.scrollIntoViewIfNeeded();`];
      return [...(step.target ? [`await ${loc(step.target)}.hover();`] : []), `await page.mouse.wheel(${round(step.dx)}, ${round(step.dy)});`];
    case 'drag': {
      const a = point(step.from);
      const b = point(step.to);
      if (!a && !b) return [`await ${loc(step.from)}.dragTo(${loc(step.to)});`];
      if (a) coordinates(step.from);
      if (b) coordinates(step.to);
      const at = (t: StepTarget, p: { x: number; y: number } | undefined, verb: string) => (p ? [`await page.mouse.move(${round(p.x)}, ${round(p.y)});`] : [`await ${loc(t)}.hover();`]).concat(verb ? [verb] : []);
      return ['// Drag by coordinates: replace them with locators.', ...at(step.from, a, 'await page.mouse.down();'), ...at(step.to, b, 'await page.mouse.up();')];
    }
    case 'upload': {
      const files = step.files.length === 1 ? quote(step.files[0]!) : `[${step.files.map(f => quote(f)).join(', ')}]`;
      if (!step.chooser) return [`await ${loc(step.target)}.setInputFiles(${files});`];
      return [`const fileChooserPromise${n} = page.waitForEvent('filechooser');`, `await ${loc(step.target)}.click();`, `await (await fileChooserPromise${n}).setFiles(${files});`];
    }
    case 'dialog':
      return [`page.once('dialog', dialog => dialog.${step.accept ? `accept(${step.promptText !== undefined ? quote(step.promptText) : ''})` : 'dismiss()'});`];
    case 'expectText': {
      const l = renderLocator({ frames: step.frames ?? [], parts: [{ kind: 'text', value: step.text }] });
      if (step.gone) return [`await expect(${l}.filter({ visible: true })).toHaveCount(0);`];
      return [`await expect(${l}.first()).toBeVisible();`];
    }
    case 'expectSelector': {
      const chain = selectorChain(step.selector);
      const l = renderLocator(step.frames?.length && chain.frames.length === 0 ? { ...chain, frames: step.frames } : chain);
      if (step.state === 'detached') return [`await expect(${l}).toHaveCount(0);`];
      const matcher = step.state === 'hidden' ? 'toBeHidden' : step.state === 'attached' ? 'toBeAttached' : 'toBeVisible';
      return [`await expect(${l}.first()).${matcher}();`];
    }
    case 'expectUrl':
      return [`await expect(page).toHaveURL(${urlAssertion(step.url)});`];
    case 'expectUrlPattern':
      return [`await expect(page).toHaveURL(${urlPatternCode(step.pattern)});`];
    case 'waitLoad':
      return [`await page.waitForLoadState(${quote(step.state)});`];
    case 'waitTime':
      return [`await page.waitForTimeout(${round(step.ms)});`];
    case 'note':
      return step.text.split('\n').map(l => `// ${l}`);
  }
}

/** Generates the test file. */
export function generateTest(source: TestSource): GeneratedTest {
  const warnings: string[] = [];
  const env = new Set<string>();
  const body: string[] = [];
  const steps = source.steps;
  const first = steps.find(s => s.kind !== 'note' && s.kind !== 'expectUrl');
  if (!first || first.kind !== 'goto') {
    if (/^https?:|^file:/.test(source.startUrl)) body.push(`await page.goto(${quote(source.startUrl)});`);
    else warnings.push('the recording did not start on a web page; add a page.goto() first');
  }
  if (source.dropped) body.push(`// The first ${source.dropped} recorded steps were dropped (the recording keeps the last ${steps.length}).`);
  let n = 0;
  for (const step of steps) {
    n++;
    for (const t of [('target' in step ? step.target : undefined), ...(step.kind === 'drag' ? [step.from, step.to] : [])]) {
      if (t && 'locator' in t && !t.robust) warnings.push(`step ${n} (${t.label}) uses a locator that depends on order or page structure (${renderLocator(t.locator)}); a test id or an accessible name would be sturdier`);
    }
    for (const v of [step.kind === 'fill' || step.kind === 'type' ? step.value : undefined]) if (v && isSecret(v)) env.add(v.env);
    if (step.kind === 'note' && step.text.startsWith('Left out:')) warnings.push(step.text.replace(/^Left out: /, 'left out: '));
    body.push(...stepLines(step, w => warnings.push(w), n));
  }
  const usesExpect = body.some(l => l.includes('expect('));
  const header = [`import { test${usesExpect ? ', expect' : ''} } from '@playwright/test';`, ''];
  if (env.size) header.push(`// Needs ${[...env].map(e => `${e}`).join(', ')} in the environment: values typed into secret fields are not recorded.`);
  const code = [...header, `test(${quote(source.name)}, async ({ page }) => {`, ...body.map(l => `  ${l}`), '});', ''].join('\n');
  return { code, env: [...env], warnings, steps: steps.length };
}

/** A name for an environment variable holding the secret typed into a field labelled `label`. */
export function secretEnvName(label: string, taken: Set<string>): string {
  const base = label
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase()
    .replace(/^(\d)/, '_$1')
    .slice(0, 40) || 'SECRET';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}
