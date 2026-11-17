// What Copane offers VS Code's own MCP client: plain data, no `vscode`, so it is unit-tested.
import { Env } from '../../shared/protocol';

/**
 * The server's name in VS Code. The same as the `copane` entry in Copilot's mcp-config.json on
 * purpose: VS Code's MCP registry treats servers whose labels are equal (ignoring case) as one and,
 * with its default `chat.mcp.collisionBehavior` "disable", keeps the one of higher priority, which is
 * an extension's (order 300) before Copilot CLI discovery (400). The Copilot harness receives a
 * forwarded definition under its label, so there it carries the same name as Copilot's own entry.
 */
export const SERVER_LABEL = 'copane';

/** The provider id; `contributes.mcpServerDefinitionProviders[].id` in contributes/vscodeChat.json. */
export const PROVIDER_ID = 'copane.window';

export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** A stdio server definition as `vscode.McpStdioServerDefinition` takes it. */
export interface DefinitionData {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  version: string;
}

export interface DefinitionInput {
  /** The setting `copane.vscodeChat.serverDefinition`. */
  enabled: boolean;
  /** How agents start the server (the registration module's launcher); undefined when unknown. */
  spec: LaunchSpec | undefined;
  /** Why the server is not installed, if it is not. */
  installError: string | undefined;
  /** This window's instance id (`COPANE_INSTANCE` in its terminals). */
  instanceId: string;
  /** The extension's version: a new one makes VS Code refresh the server's tools. */
  version: string;
}

/**
 * The definitions to offer: none while the setting is off or the server cannot be started, else one,
 * the launcher agents are registered with plus `COPANE_INSTANCE` naming this window, so the server
 * connects here wherever it is started (by this window's extension host, or by an Agent Host that
 * serves several windows). No `cwd`: VS Code reports a working directory as not portable to the
 * Copilot harness. `COPANE_SESSION` is left out: one key would make every chat one session.
 */
export function serverDefinitions(input: DefinitionInput): { definitions: DefinitionData[]; reason?: string } {
  if (!input.enabled) return { definitions: [], reason: 'the setting copane.vscodeChat.serverDefinition is off' };
  if (!input.spec) return { definitions: [], reason: 'the MCP server launcher is not known (the registration module did not start)' };
  if (input.installError) return { definitions: [], reason: `the MCP server could not be installed: ${input.installError}` };
  const env: Record<string, string> = { ...input.spec.env, [Env.instance]: input.instanceId };
  return {
    definitions: [{ label: SERVER_LABEL, command: input.spec.command, args: [...input.spec.args], env, version: input.version }],
  };
}
