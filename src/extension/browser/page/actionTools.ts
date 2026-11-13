// Tools that act on the page with real input: click, type, fill_form, press_key, hover, select_option,
// scroll, drag, upload_file. Each waits for its element to be actionable, acts, then reports in a line
// or two what happened as a result (navigation, dialog, console errors, failed requests, new tabs).
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { markAction, report, settle } from './effects';
import { click, mouseMove, prepareInput, pressChord, typeText, wheel } from './input';
import { chordLabel, parseChord, type Modifier } from './keys';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { elementArgs, modifiersArg, pointArgs, tabArg } from './schema';
import { DEEP_ACTIVE_ELEMENT, DESCRIBE, FOCUS, FOCUS_FOR_TYPING, READ_VALUE, SCROLL_STATE, SELECT_OPTIONS, SET_INPUT_VALUE, SUPPRESS_NATIVE_CONTEXT_MENU } from './scripts';
import { actionPoint, inspect, resolveTarget, scrollIntoView, viewport, type ElementInfo, type ElementTarget, type Target } from './targets';

function normalizeModifiers(mods: Array<Modifier | 'ControlOrMeta'> | undefined, isMac: boolean): Modifier[] {
  const out: Modifier[] = [];
  for (const m of mods ?? []) {
    const actual: Modifier = m === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : m;
    if (!out.includes(actual)) out.push(actual);
  }
  return out;
}

function requireTarget(target: Target | undefined, what = 'an element'): Target {
  if (!target) throw new ToolError('invalid_input', `Say which element: pass ref (from browser_snapshot)${what === 'an element' ? ' or selector' : ', selector, or x and y'}.`);
  return target;
}

/**
 * Runs an action and reports it with its effects. A dialog opening mid-action is not an error: it is
 * reported. When the target was a ref of this session, its remembered role/name are refreshed, so the
 * next action on the same ref (e.g. a counter button whose label changed) still works.
 */
async function act(call: PageCall, target: Target | undefined, summary: string | (() => string), fn: () => Promise<string | void>, options: { expectNavigation?: boolean } = {}): Promise<string> {
  await prepareInput(call);
  const mark = markAction(call);
  let extra: string | void = undefined;
  try {
    extra = await fn();
  } catch (err) {
    if (!(err instanceof DialogInterrupt)) throw err;
  }
  const effects = await settle(call, mark, options);
  let now = '';
  if (target?.kind === 'element' && target.ref && !call.state.dialog && call.state.loaderId === mark.loaderId) {
    const entry = call.refs.get(target.ref);
    const ax = await call.describeAx(target.backendNodeId).catch(() => undefined);
    if (entry && ax && !ax.ignored && (ax.role !== entry.role || ax.name !== entry.name)) {
      call.refs.update(target.ref, ax.role, ax.name);
      now = ` It is now ${ax.role}${ax.name ? ` "${clip(ax.name, 80)}"` : ''}.`;
    }
  }
  const head = typeof summary === 'function' ? summary() : summary;
  return report(`${head}${extra ? ` ${extra}` : ''}${now}`, effects);
}

async function focusedDescription(call: PageCall): Promise<string | undefined> {
  try {
    const handle = await call.evaluateHandle(DEEP_ACTIVE_ELEMENT);
    if (!handle.objectId || handle.subtype === 'null') return undefined;
    const { node } = await call.send('DOM.describeNode', { objectId: handle.objectId });
    const ax = await call.describeAx(node.backendNodeId);
    if (ax && !ax.ignored && ax.role !== 'generic') return `${ax.role}${ax.name ? ` "${clip(ax.name, 80)}"` : ''}`;
    return await call.callOn<string>(handle.objectId, DESCRIBE);
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    return undefined;
  }
}

/** Puts text into a field the way a user would: focus, select the old text (clear), type. */
async function fillField(call: PageCall, target: ElementTarget, info: ElementInfo, value: string, options: { clear: boolean; slowly: boolean }): Promise<string | void> {
  if (info.kind === 'value') {
    const now = await call.callOn<string>(target.objectId, SET_INPUT_VALUE, [value]);
    if (now !== value) return `The field rejected it and holds "${clip(now, 100)}" (expected format for ${info.type} inputs, e.g. ${info.type === 'date' ? '2024-12-31' : info.type === 'time' ? '13:45' : info.type === 'color' ? '#ff0000' : 'a valid value'}).`;
    return;
  }
  if (info.kind !== 'text' && info.kind !== 'contenteditable') {
    const suggestion = info.kind === 'select' ? 'use browser_select_option' : info.kind === 'checkbox' || info.kind === 'radio' ? 'use browser_click' : info.kind === 'file' ? 'use browser_upload_file' : 'click it, or target the text field itself';
    throw new ToolError('invalid_input', `${target.label} is not a text field (it is ${info.kind === 'other' ? `a <${info.tag}>` : `a ${info.kind}`}); ${suggestion}.`);
  }
  const focused = await call.callOn<boolean>(target.objectId, FOCUS_FOR_TYPING, [options.clear]);
  if (!focused) {
    // Some widgets only take focus from a real click.
    const point = await actionPoint(call, target, { verb: 'focus', enabled: true });
    await click(call, point.x, point.y);
    await call.callOn(target.objectId, FOCUS_FOR_TYPING, [options.clear]);
  }
  if (value === '') {
    if (options.clear) await pressChord(call, parseChord('Backspace', call.state.isMac));
  } else {
    await typeText(call, value, options.slowly);
  }
  const now = await call.callOn<string>(target.objectId, READ_VALUE);
  if (options.clear && info.kind === 'text' && now !== value) {
    if (now === '' && value !== '' && !options.slowly) {
      // The text did not arrive (an editor that ignores inserted text): fall back to setting the value.
      const set = await call.callOn<string>(target.objectId, SET_INPUT_VALUE, [value]);
      if (set === value) return;
    }
    return `The field now holds "${clip(now, 200)}", not exactly what was typed (the page reformatted or limited it).`;
  }
  if (!options.clear && info.kind === 'text' && !now.endsWith(value)) return `The field now holds "${clip(now, 200)}".`;
}

export function actionTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_click',
      title: 'Click',
      description:
        'Clicks an element with a real mouse event, after waiting (up to 5 s) until it is visible, enabled, scrolled into view and not covered. Supports double and right click and modifier keys. Returns what the click led to: navigation, dialog, console errors, failed requests, new tabs. Target by ref (from browser_snapshot), CSS selector, or viewport x/y.',
      input: {
        ...pointArgs,
        button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
        doubleClick: z.boolean().optional().describe('Double-click instead of a single click.'),
        modifiers: modifiersArg,
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = requireTarget(await resolveTarget(call, args, { allowPoint: true }), 'point');
          const point = await actionPoint(call, target, { verb: 'click', enabled: true });
          const modifiers = normalizeModifiers(args.modifiers, call.state.isMac);
          const kind = `${args.doubleClick ? 'Double-clicked' : args.button === 'right' ? 'Right-clicked' : args.button === 'middle' ? 'Middle-clicked' : 'Clicked'}`;
          const withMods = modifiers.length ? ` with ${modifiers.join('+')}` : '';
          return act(call, target, `${kind} ${target.label}${withMods}.`, async () => {
            if (args.button === 'right') await call.evaluate(SUPPRESS_NATIVE_CONTEXT_MENU);
            await click(call, point.x, point.y, { button: args.button ?? 'left', clickCount: args.doubleClick ? 2 : 1, modifiers });
          });
        }),
    }),
    defineTool({
      name: 'browser_type',
      title: 'Type text',
      description:
        'Types text into a text field, textarea or contenteditable element: focuses it, replaces its content (unless clear is false) and types with real input events. Without ref/selector it types into the element that has focus. submit presses Enter afterwards. Returns what happened, including when the page changed what was typed.',
      input: {
        ...elementArgs,
        text: z.string().describe('Text to type.'),
        clear: z.boolean().optional().describe('Replace the current content (default true). false appends at the end.'),
        slowly: z.boolean().optional().describe('Type one key at a time (fires keydown/keyup per character, e.g. for search-as-you-type or key handlers). Default false: insert the text in one go.'),
        submit: z.boolean().optional().describe('Press Enter after typing.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = (await resolveTarget(call, args)) as ElementTarget | undefined;
          const clear = args.clear ?? true;
          if (!target) {
            const focused = await focusedDescription(call);
            if (!focused) throw new ToolError('invalid_input', 'Nothing has focus to type into. Pass ref or selector of the field.');
            return act(call, undefined, `Typed ${JSON.stringify(clip(args.text, 80))} into the focused ${focused}${args.submit ? ' and pressed Enter' : ''}.`, async () => {
              await typeText(call, args.text, Boolean(args.slowly));
              if (args.submit) await pressChord(call, parseChord('Enter', call.state.isMac));
            });
          }
          const info = await inspect(call, target);
          if (info.kind === 'text' || info.kind === 'contenteditable' || info.kind === 'value') {
            await actionPoint(call, target, { verb: 'type into', enabled: true, editable: true });
          }
          return act(
            call,
            target,
            `Typed ${JSON.stringify(clip(args.text, 80))} into ${target.label}${args.submit ? ' and pressed Enter' : ''}.`,
            async () => {
              const note = await fillField(call, target, info, args.text, { clear, slowly: Boolean(args.slowly) });
              if (args.submit) await pressChord(call, parseChord('Enter', call.state.isMac));
              return note;
            },
            { expectNavigation: false },
          );
        }),
    }),
    defineTool({
      name: 'browser_fill_form',
      title: 'Fill form fields',
      description:
        'Fills several form fields in one call: text fields get text (replacing their content), checkboxes and radios true/false, selects the option label(s) or value(s). Stops at the first field that fails and says which fields were filled.',
      input: {
        fields: z
          .array(
            z.object({
              ref: z.string().optional().describe('Element ref from browser_snapshot.'),
              selector: z.string().optional().describe('CSS selector, instead of ref.'),
              value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe('Text, true/false for a checkbox or radio, or option(s) for a select.'),
            }),
          )
          .min(1)
          .max(50)
          .describe('Fields in the order to fill them.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const done: string[] = [];
          await prepareInput(call);
          const mark = markAction(call);
          for (const [i, field] of args.fields.entries()) {
            try {
              const target = requireTarget(await resolveTarget(call, field)) as ElementTarget;
              const info = await inspect(call, target);
              if (info.kind === 'checkbox' || info.kind === 'radio') {
                if (typeof field.value !== 'boolean') throw new ToolError('invalid_input', `${target.label} is a ${info.kind}: pass true or false.`);
                if (info.checked !== field.value) {
                  if (info.kind === 'radio' && !field.value) throw new ToolError('invalid_input', `${target.label} is a radio button; set another option of its group to true instead of unchecking it.`);
                  const point = await actionPoint(call, target, { verb: 'click', enabled: true });
                  await click(call, point.x, point.y);
                }
                done.push(`${target.label} → ${field.value ? 'checked' : 'unchecked'}`);
              } else if (info.kind === 'select') {
                const values = Array.isArray(field.value) ? field.value : [String(field.value)];
                const selected = await selectOptions(call, target, values);
                done.push(`${target.label} → ${selected.map(s => `"${s}"`).join(', ')}`);
              } else {
                if (typeof field.value !== 'string') throw new ToolError('invalid_input', `${target.label} takes text; pass a string.`);
                await actionPoint(call, target, { verb: 'type into', enabled: true, editable: true });
                const note = await fillField(call, target, info, field.value, { clear: true, slowly: false });
                done.push(`${target.label} → ${JSON.stringify(clip(field.value, 60))}${note ? ` (${note})` : ''}`);
              }
            } catch (err) {
              if (err instanceof DialogInterrupt) break;
              if (err instanceof ToolError && err.code !== 'cancelled') {
                const filled = done.length ? `\nFilled before it: ${done.join('; ')}.` : '';
                throw new ToolError(err.code, `Field ${i + 1} failed: ${err.message}${filled}`);
              }
              throw err;
            }
          }
          const effects = await settle(call, mark);
          return report(`Filled ${done.length} field${done.length === 1 ? '' : 's'}:\n${done.map(d => `- ${d}`).join('\n')}`, effects);
        }),
    }),
    defineTool({
      name: 'browser_press_key',
      title: 'Press key',
      description:
        'Presses a key or key combination with real key events, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Shift+Tab", "ControlOrMeta+k". Goes to the focused element, or focuses ref/selector first. Reports where focus went and what the key press led to.',
      input: {
        key: z.string().min(1).describe('Key name (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, Space, or a character), optionally with modifiers joined by "+".'),
        ...elementArgs,
        count: z.number().int().min(1).max(100).optional().describe('Press it this many times. Default 1.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          let chord;
          try {
            chord = parseChord(args.key, call.state.isMac);
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          const target = (await resolveTarget(call, args)) as ElementTarget | undefined;
          if (target) {
            await actionPoint(call, target, { verb: 'focus', enabled: false });
            await call.callOn(target.objectId, FOCUS);
          }
          const count = args.count ?? 1;
          const result = await act(call, undefined, `Pressed ${chordLabel(chord)}${count > 1 ? ` ${count} times` : ''}${target ? ` in ${target.label}` : ''}.`, async () => {
            for (let i = 0; i < count; i++) await pressChord(call, chord);
          });
          if (call.state.dialog || call.page.closed) return result;
          const focus = await focusedDescription(call);
          return focus ? `${result}\nFocus is on ${focus}.` : result;
        }),
    }),
    defineTool({
      name: 'browser_hover',
      title: 'Hover',
      description: 'Moves the mouse over an element (ref, selector or x/y), e.g. to open a hover menu or show a tooltip. Take a snapshot or screenshot afterwards to see what appeared.',
      input: { ...pointArgs, tab: tabArg },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = requireTarget(await resolveTarget(call, args, { allowPoint: true }), 'point');
          const point = await actionPoint(call, target, { verb: 'hover', enabled: false });
          return act(call, target, `Hovering over ${target.label}.`, () => mouseMove(call, point.x, point.y));
        }),
    }),
    defineTool({
      name: 'browser_select_option',
      title: 'Select option',
      description: 'Selects option(s) in a <select> by visible label or value, firing input and change like a user would. For custom dropdowns (not a <select>), click them open and click the option instead.',
      input: {
        ...elementArgs,
        values: z.array(z.string()).min(1).describe('Option labels or values. More than one only for a multiple select.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = requireTarget(await resolveTarget(call, args)) as ElementTarget;
          await actionPoint(call, target, { verb: 'select in', enabled: true });
          let selected: string[] = [];
          return act(call, target, () => `Selected ${selected.map(v => `"${v}"`).join(', ')} in ${target.label}.`, async () => {
            selected = await selectOptions(call, target, args.values);
          });
        }),
    }),
    defineTool({
      name: 'browser_scroll',
      title: 'Scroll',
      description:
        'Scrolls the page or a scrollable element. With only ref/selector: scrolls that element into view. With direction: scrolls with the mouse wheel over the element (or the page) by amount pixels. With to: jumps to the top or bottom. Reports the new position and how much is left.',
      input: {
        ...elementArgs,
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll with the mouse wheel in this direction.'),
        amount: z.number().min(1).max(100_000).optional().describe('Pixels to scroll with direction. Default: most of a screen.'),
        to: z.enum(['top', 'bottom', 'left', 'right']).optional().describe('Jump to an edge of the page, or of the scrollable element under ref/selector.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = (await resolveTarget(call, args)) as ElementTarget | undefined;
          if (args.direction && args.to) throw new ToolError('invalid_input', 'Pass either direction or to, not both.');
          const vp = await viewport(call);
          let point = { x: vp.width / 2, y: vp.height / 2 };
          if (target) {
            await scrollIntoView(call, target);
            if (!args.direction && !args.to) {
              const state = await call.evaluate<ScrollState>(SCROLL_STATE, [null, null, null, 0, 0]);
              return act(call, target, `Scrolled ${target.label} into view. ${describeScroll(state)}`, async () => {});
            }
            const p = await actionPoint(call, target, { verb: 'scroll', enabled: false });
            point = { x: p.x, y: p.y };
          }
          if (!args.direction && !args.to) throw new ToolError('invalid_input', 'Say how to scroll: direction, to, or an element (ref/selector) to bring into view.');
          let state: ScrollState | undefined;
          const how = args.to ? `Scrolled to the ${args.to}` : `Scrolled ${args.direction}`;
          return act(call, undefined, () => `${how}.${state ? ` ${describeScroll(state)}` : ''}`, async () => {
            if (args.to) {
              state = await call.evaluate<ScrollState>(SCROLL_STATE, [point.x, point.y, args.to, 0, 0]);
              return;
            }
            const vertical = args.direction === 'up' || args.direction === 'down';
            const amount = args.amount ?? Math.round((vertical ? vp.height : vp.width) * 0.8);
            const sign = args.direction === 'up' || args.direction === 'left' ? -1 : 1;
            const dx = vertical ? 0 : sign * amount;
            const dy = vertical ? sign * amount : 0;
            // A real wheel event first. A tab that is not on screen may not answer it or not scroll
            // (no frames are drawn); then scroll the same container from script instead.
            const before = await call.evaluate<ScrollState>(SCROLL_STATE, [point.x, point.y, null, 0, 0]);
            if (await wheelWorks(call, point.x, point.y, dx, dy)) {
              await call.sleep(150);
              state = await call.evaluate<ScrollState>(SCROLL_STATE, [point.x, point.y, null, 0, 0]);
            }
            if (!state || (state.top === before.top && state.left === before.left)) {
              state = await call.evaluate<ScrollState>(SCROLL_STATE, [point.x, point.y, null, dx, dy]);
            }
          });
        }),
    }),
    defineTool({
      name: 'browser_drag',
      title: 'Drag and drop',
      description:
        'Drags from one element (or point) to another with real mouse events: press, move in steps, release. Works for HTML5 drag and drop (draggable elements) and for pointer-based dragging (sliders, sortable lists, canvas).',
      input: {
        fromRef: z.string().optional().describe('Ref of the element to drag.'),
        fromSelector: z.string().optional().describe('CSS selector of the element to drag.'),
        fromX: z.number().optional().describe('Viewport x to start the drag at.'),
        fromY: z.number().optional().describe('Viewport y to start the drag at.'),
        toRef: z.string().optional().describe('Ref of the element to drop on.'),
        toSelector: z.string().optional().describe('CSS selector of the element to drop on.'),
        toX: z.number().optional().describe('Viewport x to drop at.'),
        toY: z.number().optional().describe('Viewport y to drop at.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const from = requireTarget(await resolveTarget(call, { ref: args.fromRef, selector: args.fromSelector, x: args.fromX, y: args.fromY }, { allowPoint: true, prefix: 'from' }), 'point');
          const to = requireTarget(await resolveTarget(call, { ref: args.toRef, selector: args.toSelector, x: args.toX, y: args.toY }, { allowPoint: true, prefix: 'to' }), 'point');
          if (to.kind === 'element') await scrollIntoView(call, to);
          const start = await actionPoint(call, from, { verb: 'drag', enabled: true });
          const end = await actionPoint(call, to, { verb: 'drop onto', enabled: false });
          return act(call, from, `Dragged ${from.label} to ${to.label}.`, () => drag(call, start, end));
        }),
    }),
    defineTool({
      name: 'browser_upload_file',
      title: 'Upload file',
      description:
        'Puts local files into a file input, as if the user picked them in the file chooser. Target the <input type="file"> (it may be hidden), its label, or the button that opens the chooser. Paths are absolute or relative to your working directory.',
      input: {
        ...elementArgs,
        paths: z.array(z.string().min(1)).min(1).describe('Files to upload.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const base = ctx.session.cwd ?? env.services.window.workspaceFolders[0] ?? process.cwd();
          const files = args.paths.map(p => (isAbsolute(p) ? p : resolvePath(base, p)));
          for (const f of files) {
            if (!existsSync(f) || !statSync(f).isFile()) throw new ToolError('invalid_input', `There is no file at ${f}.`);
          }
          const target = requireTarget(await resolveTarget(call, args, { waitMs: 3000 })) as ElementTarget;
          const info = await inspect(call, target);
          const names = files.map(f => f.split(/[\\/]/).pop()).join(', ');
          let input: number | undefined;
          if (info.kind === 'file') input = target.backendNodeId;
          else if (info.hasFileInput) {
            const handle = await call.callOn(target.objectId, `function () { const c = this.tagName === 'LABEL' ? this.control : this.querySelector('input[type=file]'); return c; }`, [], { returnByValue: false });
            input = (await call.send('DOM.describeNode', { objectId: handle.objectId })).node.backendNodeId;
          }
          if (input !== undefined) {
            const multiple = info.kind === 'file' ? info.multiple : true;
            if (!multiple && files.length > 1) throw new ToolError('invalid_input', `${target.label} accepts one file; pass a single path.`);
            return act(call, target, `Set ${files.length} file${files.length > 1 ? 's' : ''} on ${target.label}: ${names}.`, async () => {
              await call.send('DOM.setFileInputFiles', { files, backendNodeId: input });
            });
          }
          // Not a file input: click it with the file chooser intercepted, and answer the chooser.
          const point = await actionPoint(call, target, { verb: 'click', enabled: true });
          let chooser: { backendNodeId: number; mode: string } | undefined;
          const sub = call.page.on('Page.fileChooserOpened', p => (chooser = p));
          await call.send('Page.setInterceptFileChooserDialog', { enabled: true });
          try {
            const summary = `Clicked ${target.label} and chose ${names} in the file chooser.`;
            return await act(call, target, summary, async () => {
              await click(call, point.x, point.y);
              await call.state.waitFor(() => chooser !== undefined, { timeoutMs: 3000, signal: call.signal });
              if (!chooser) throw new ToolError('failed', `Clicking ${target.label} did not open a file chooser. Target the <input type="file"> itself (try selector 'input[type=file]').`);
              if (chooser.mode !== 'selectMultiple' && files.length > 1) throw new ToolError('invalid_input', 'The file chooser accepts one file; pass a single path.');
              await call.send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId });
            });
          } finally {
            sub.dispose();
            if (!call.page.closed) await call.page.send('Page.setInterceptFileChooserDialog', { enabled: false }, { timeoutMs: 5000 }).catch(() => undefined);
          }
        }),
    }),
  ];
}

interface ScrollState {
  label: string;
  top: number;
  left: number;
  height: number;
  width: number;
  clientHeight: number;
  clientWidth: number;
}

function describeScroll(s: ScrollState): string {
  s = { ...s, top: Math.min(s.top, Math.max(0, s.height - s.clientHeight)), left: Math.min(s.left, Math.max(0, s.width - s.clientWidth)) };
  const below = Math.max(0, s.height - s.top - s.clientHeight);
  const right = Math.max(0, s.width - s.left - s.clientWidth);
  const where = s.label === 'page' ? 'The page' : `The scrollable ${s.label}`;
  const horizontal = s.width > s.clientWidth + 1 ? `, x=${s.left} of ${s.width - s.clientWidth}` : '';
  const more = below > 0 ? `${below} px more below` : 'at the bottom';
  return `${where} is at y=${s.top} of ${Math.max(0, s.height - s.clientHeight)}${horizontal} (${more}${right > 0 && horizontal ? `, ${right} px more to the right` : ''}).`;
}

/** Sends a wheel event; false when the browser does not take it (it would never answer). */
async function wheelWorks(call: PageCall, x: number, y: number, dx: number, dy: number): Promise<boolean> {
  try {
    await wheel(call, x, y, dx, dy);
    return true;
  } catch (err) {
    if (err instanceof ToolError && err.code === 'timeout') return false;
    throw err;
  }
}

async function selectOptions(call: PageCall, target: ElementTarget, values: string[]): Promise<string[]> {
  const r = await call.callOn<any>(target.objectId, SELECT_OPTIONS, [values]);
  if (r.error === 'not-select') throw new ToolError('invalid_input', `${target.label} is not a <select>. For a custom dropdown, click it open and click the option.`);
  if (r.error === 'single') throw new ToolError('invalid_input', `${target.label} allows only one selected option; pass one value.`);
  if (r.missing) throw new ToolError('invalid_input', `${target.label} has no option ${r.missing.map((m: string) => `"${m}"`).join(', ')}. Options: ${r.available.join(', ')}${r.total > r.available.length ? `, … (${r.total} in total)` : ''}.`);
  if (r.disabledOptions) throw new ToolError('failed', `Option ${r.disabledOptions.map((m: string) => `"${m}"`).join(', ')} of ${target.label} is disabled.`);
  return r.selected;
}

async function drag(call: PageCall, start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
  let intercepted: { data: unknown } | undefined;
  const sub = call.page.on('Input.dragIntercepted', p => (intercepted = p));
  await prepareInput(call);
  await call.send('Input.setInterceptDrags', { enabled: true });
  try {
    await mouseMove(call, start.x, start.y);
    await call.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = start.x + ((end.x - start.x) * i) / steps;
      const y = start.y + ((end.y - start.y) * i) / steps;
      await mouseMove(call, x, y, [], 1);
      if (intercepted) break;
      await call.sleep(16);
    }
    if (intercepted) {
      // HTML5 drag and drop: the browser hands the drag to us; play it out with drag events.
      const data = intercepted.data;
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await call.send('Input.dispatchDragEvent', { type, x: end.x, y: end.y, data, modifiers: 0 });
      }
      // The mouse button is still down from the browser's point of view; let it go without a click.
      await call.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
    } else {
      await mouseMove(call, end.x, end.y, [], 1);
      await call.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
    }
  } finally {
    sub.dispose();
    if (!call.page.closed) await call.page.send('Input.setInterceptDrags', { enabled: false }, { timeoutMs: 5000 }).catch(() => undefined);
  }
}

