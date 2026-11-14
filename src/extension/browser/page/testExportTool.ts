// browser_export_test: what the session did in a tab, as a Playwright test (recorder.ts, testCode.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageEnv } from './call';
import type { Recorder } from './recorder';
import { clip } from './ringBuffer';
import { tabArg } from './schema';
import { generateTest } from './testCode';

/** First line of every file the tool writes: a file without it is never overwritten. */
const MARK = '// Recorded with Copane';

export function testExportTools(env: PageEnv, recorder: Recorder): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_export_test',
      title: 'Export Playwright test',
      description: 'Your successful actions in the tab since its first action or reset, as a Playwright test with role/label locators; browser_wait_for text and url become assertions.',
      input: {
        name: z.string().optional().describe('Test title.'),
        path: z.string().optional().describe('Write it to this file, e.g. "tests/signup.spec.ts", instead of returning it.'),
        reset: z.boolean().optional().describe('Discard the recording and record from here.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', allowDialog: true, skipReady: true }, async call => {
          if (args.reset) {
            recorder.reset(ctx.session.id, call.tab.id, call.state.url);
            return `Started a new recording of ${call.tab.id} at ${clip(call.state.url, 200)}. Your next actions there are recorded; export them with browser_export_test.`;
          }
          const rec = recorder.get(ctx.session.id, call.tab.id);
          if (!rec || rec.steps.length === 0) {
            return `Nothing is recorded for ${call.tab.id} yet: recording covers your own successful actions in this tab (navigate, click, type, fill_form, press_key, hover, drag, upload_file, wait_for, ...). Do the flow, then call this again.`;
          }
          const title = args.name ?? (call.tab.title ? `flow on ${clip(call.tab.title, 60)}` : 'recorded flow');
          const test = generateTest({ name: title, startUrl: rec.startUrl, steps: rec.steps, dropped: rec.dropped });
          const code = `${MARK} from ${call.tab.id} (${test.steps} steps).\n${test.code}`;
          const notes = [
            test.env.length ? `Set ${test.env.join(', ')} before running it: what you typed into secret fields is not in the test.` : '',
            ...test.warnings.slice(0, 8).map(w => `Note: ${w.replace(/\.$/, '')}.`),
            test.warnings.length > 8 ? `(${test.warnings.length - 8} more notes in the code.)` : '',
            'Not in the test: logins, cookies and other state the tab already had, mocks (browser_route) and emulation. Failed actions were left out.',
          ].filter(Boolean);
          if (args.path === undefined) return `${'```ts'}\n${code}${'```'}\n${notes.join('\n')}`;

          const base = ctx.session.cwd ?? env.services.window.workspaceFolders[0];
          if (!base && !isAbsolute(args.path)) throw new ToolError('invalid_input', 'There is no working directory to resolve the path against; pass an absolute path.');
          const file = isAbsolute(args.path) ? args.path : resolvePath(base!, args.path);
          const roots = [ctx.session.cwd, ...env.services.window.workspaceFolders].filter((r): r is string => !!r);
          const inside = roots.some(r => {
            const rel = relative(r, file);
            return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
          });
          if (!inside) throw new ToolError('invalid_input', `${file} is outside your working directory and the workspace folders; write the test inside the project.`);
          if (!/\.(ts|js|mjs|cjs)$/.test(file)) throw new ToolError('invalid_input', 'The path must end in .ts or .js (e.g. tests/signup.spec.ts).');
          if (existsSync(file) && !readFileSync(file, 'utf8').startsWith(MARK)) {
            throw new ToolError('invalid_input', `${file} exists and was not written by browser_export_test; pick another path (it is never overwritten).`);
          }
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, code);
          const shown = base ? relative(base, file) : file;
          return [`Wrote ${shown} (${test.steps} steps). Run it with: npx playwright test ${shown}`, ...notes].join('\n');
        }),
    }),
  ];
}
