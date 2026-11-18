// Where a tool may write a file for an agent, by the same rules as browser_export_test
// (testExportTool.ts): inside the session's working directory or a workspace folder, with an expected
// extension, and never over a file the tool did not write itself.
import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { ToolError } from '../../core/errors';
import type { ToolContext } from '../../core/tools';
import type { PageEnv } from './call';

export interface AgentFileRules {
  /** Lower-case extensions with the dot, e.g. [".har"]. */
  extensions: string[];
  /** e.g. 'The path must end in .har (e.g. "network.har").' */
  extensionHint: string;
  /** True when the first bytes of an existing file show the tool wrote it. */
  isOurs(head: string): boolean;
  /** For messages: "browser_network_requests". */
  tool: string;
}

export interface AgentFile {
  file: string;
  /** Relative to the working directory when inside it. */
  shown: string;
}

/** Resolves and checks the path; throws ToolError (invalid_input) with what to do instead. */
export function agentFilePath(env: PageEnv, ctx: ToolContext, path: string, rules: AgentFileRules): AgentFile {
  const base = ctx.session.cwd ?? env.services.window.workspaceFolders[0];
  if (!base && !isAbsolute(path)) throw new ToolError('invalid_input', 'There is no working directory to resolve the path against; pass an absolute path.');
  const file = isAbsolute(path) ? path : resolvePath(base!, path);
  const roots = [ctx.session.cwd, ...env.services.window.workspaceFolders].filter((r): r is string => !!r);
  const inside = roots.some(r => {
    const rel = relative(r, file);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside) throw new ToolError('invalid_input', `${file} is outside your working directory and the workspace folders; write it inside the project.`);
  if (!rules.extensions.includes(extname(file).toLowerCase())) throw new ToolError('invalid_input', rules.extensionHint);
  if (existsSync(file) && !rules.isOurs(readHead(file))) {
    throw new ToolError('invalid_input', `${file} exists and was not written by ${rules.tool}; pick another path (it is never overwritten).`);
  }
  return { file, shown: base ? relative(base, file) : file };
}

export function writeAgentFile(target: AgentFile, data: string | Uint8Array): void {
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, data);
}

function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
