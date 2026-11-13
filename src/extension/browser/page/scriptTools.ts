// browser_evaluate (the escape hatch) and browser_handle_dialog.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { exceptionText, withPage, type PageCall, type PageEnv } from './call';
import { describeChanges, pageBefore } from './changes';
import { markAction, report, settle } from './effects';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { elementArgs, tabArg } from './schema';
import { SERIALIZE, wrapUserFunction } from './scripts';
import { resolveTarget, type ElementTarget } from './targets';

const MAX_RESULT = 20_000;

async function serialize(call: PageCall, remote: any): Promise<string> {
  if (remote.type === 'undefined') return 'undefined';
  if (remote.type === 'string') {
    const s = String(remote.value);
    return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n… (cut: ${s.length} characters in total)` : s;
  }
  if (!remote.objectId) return remote.unserializableValue ?? JSON.stringify(remote.value) ?? String(remote.description);
  return call.callOn<string>(remote.objectId, SERIALIZE, [MAX_RESULT]);
}

export function scriptTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_evaluate',
      title: 'Run JavaScript in page',
      description: 'Runs JavaScript in the page and returns the result: an expression, statements or a function (awaited). With ref/selector a function gets the element: "(el) => el.value".',
      input: {
        function: z.string().min(1),
        ...elementArgs,
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control' }, async call => {
          const target = (await resolveTarget(call, args, { waitMs: 3000 })) as ElementTarget | undefined;
          const mark = markAction(call);
          let output: string | undefined;
          let interrupted = false;
          let scope = call;
          try {
            let remote: any;
            if (target) {
              // In the element's own frame (a cross-origin frame's target when it lives in one).
              scope = target.call;
              const r = await scope.send('Runtime.callFunctionOn', { functionDeclaration: wrapUserFunction(args.function), objectId: target.objectId, arguments: [{ objectId: target.objectId }], awaitPromise: true, userGesture: true, objectGroup: call.group });
              if (r.exceptionDetails) throw new ToolError('failed', `The script threw: ${exceptionText(r.exceptionDetails)}`);
              remote = r.result;
            } else {
              const contextId = call.state.mainWorld();
              const base = { awaitPromise: true, userGesture: true, replMode: true, objectGroup: call.group, ...(contextId !== undefined ? { contextId } : {}) };
              // Try it as an expression first (so a function literal is returned, not declared).
              let r = await call.send('Runtime.evaluate', { ...base, expression: `(${args.function}\n)` });
              if (r.exceptionDetails && /SyntaxError/.test(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '')) {
                r = await call.send('Runtime.evaluate', { ...base, expression: args.function });
              }
              if (r.exceptionDetails) throw new ToolError('failed', `The script threw: ${exceptionText(r.exceptionDetails)}`);
              remote = r.result;
              if (remote.type === 'function') {
                const called = await call.send('Runtime.callFunctionOn', { functionDeclaration: 'async function () { return await this(); }', objectId: remote.objectId, awaitPromise: true, userGesture: true, objectGroup: call.group });
                if (called.exceptionDetails) throw new ToolError('failed', `The function threw: ${exceptionText(called.exceptionDetails)}`);
                remote = called.result;
              }
            }
            // REPL mode does not await a promise the code evaluates to (`fetch(...).then(...)`), so do it here.
            if (remote?.subtype === 'promise' && remote.objectId) {
              const awaited = await scope.send('Runtime.awaitPromise', { promiseObjectId: remote.objectId, generatePreview: false });
              if (awaited.exceptionDetails) throw new ToolError('failed', `The promise was rejected: ${exceptionText(awaited.exceptionDetails)}`);
              remote = awaited.result;
            }
            output = await serialize(scope, remote);
          } catch (err) {
            if (!(err instanceof DialogInterrupt)) throw err;
            interrupted = true;
          }
          const effects = await settle(call, mark);
          if (interrupted) return report('The script opened a dialog before it finished, so it has no result yet.', effects);
          return effects.length ? `${output}\n---\n${effects.join('\n')}` : output!;
        }),
    }),
    defineTool({
      name: 'browser_handle_dialog',
      title: 'Answer dialog',
      description: 'Answers the alert, confirm, prompt or "leave this page?" dialog that blocks the tab. The user does not see these dialogs.',
      input: {
        accept: z.boolean().describe('OK / Leave, or Cancel / Stay.'),
        promptText: z.string().optional(),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control', allowDialog: true, skipReady: true }, async call => {
          const dialog = call.state.dialog;
          const before = await pageBefore(call, { cachedOnly: true });
          const mark = markAction(call);
          try {
            await call.send('Page.handleJavaScriptDialog', { accept: args.accept, ...(args.promptText !== undefined ? { promptText: args.promptText } : {}) }, { allowDialog: true, timeoutMs: 5000 });
          } catch (err) {
            if (err instanceof ToolError && err.code !== 'timeout') throw err;
            if (/No dialog is showing/i.test(err instanceof Error ? err.message : '')) throw new ToolError('not_found', `No dialog is open in ${call.tab.id}.`);
            throw err;
          }
          const what = dialog ? `the ${dialog.type} dialog${dialog.message ? ` "${clip(dialog.message, 200)}"` : ''}` : 'the dialog';
          const verb = args.accept ? 'Accepted' : 'Dismissed';
          const effects = await settle(call, mark, {});
          const changes = await describeChanges(call, before);
          return report(`${verb} ${what}${args.promptText !== undefined && args.accept ? ` with "${clip(args.promptText, 100)}"` : ''}.`, [...effects, ...changes]);
        }),
    }),
  ];
}

