// Tools that exist only when the extension runs from source (`--extensionDevelopmentPath`), i.e. in a
// dev host. They let tests do what otherwise needs a person: run a VS Code command (open a tab or a
// terminal "as the user") and answer the extension's prompts.
import * as vscode from 'vscode';
import { z } from 'zod';
import type { VscodePrompts } from './prompts';
import type { BridgeServices } from './services';
import { defineTool, json } from './tools';

export function activateDebugTools(services: BridgeServices, prompts: VscodePrompts): void {
  if (services.context.extensionMode !== vscode.ExtensionMode.Development) return;
  services.context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'debug_vscode_command',
        description:
          'Development only. Runs a VS Code command in this window, standing in for the user: e.g. "workbench.action.browser.open" with args ["http://localhost:3000"] opens a browser tab as the user would, "workbench.action.terminal.new" a terminal.',
        input: {
          command: z.string(),
          args: z.array(z.any()).optional(),
        },
        handler: async args => {
          const result = await vscode.commands.executeCommand(args.command, ...(args.args ?? []));
          return result === undefined ? 'ok' : [json(result)];
        },
      }),
      defineTool({
        name: 'debug_answer_prompts',
        description:
          'Development only. Queues answers for the next prompts the extension would show the user (consent, hand-off, login), in order. Each answer is the exact button label, or for an input prompt the text to type; null dismisses. Also returns the prompts shown so far (typed passwords are shown as "(hidden)").',
        input: {
          answers: z.array(z.string().nullable()).optional().describe('Answers to queue. Omit to only read the history.'),
          clear: z.boolean().optional().describe('Drop answers that are still queued first.'),
        },
        handler: args => {
          if (args.clear) prompts.queuedAnswers.length = 0;
          prompts.queuedAnswers.push(...(args.answers ?? []));
          return [json({ queued: prompts.queuedAnswers, shown: prompts.history })];
        },
      }),
    ]),
  );
}
