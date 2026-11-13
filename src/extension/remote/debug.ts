// Development only: runs JavaScript in this extension host with `vscode` in scope. In a remote dev host
// (scripts/remote-dev-host.mjs) that is the remote side, which is how what crosses the boundary to the
// user's machine is tried out for real.
import * as vscode from 'vscode';
import { z } from 'zod';
import type { BridgeServices } from '../core/services';
import { defineTool, json } from '../core/tools';

export function remoteDebugTools(services: BridgeServices) {
  if (services.context.extensionMode !== vscode.ExtensionMode.Development) return [];
  return [
    defineTool({
      name: 'debug_extension_eval',
      description: 'Development only. Runs an async JavaScript function body in the extension host (`vscode`, `services`, `require` in scope) and returns its result as JSON.',
      input: { code: z.string() },
      handler: async args => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('vscode', 'services', 'require', `return (async () => { ${args.code} })();`);
        const result = await fn(vscode, services, require);
        return [json(result === undefined ? null : result)];
      },
    }),
  ];
}
