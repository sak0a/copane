// Wire protocol between the MCP stdio server (one process per agent session, spawned by Claude Code,
// Codex, ...) and the bridge server that runs inside a VS Code window's extension host.
//
// Transport: JSON-RPC 2.0, one JSON object per line (NDJSON), over a unix domain socket (named pipe on
// Windows). The MCP server is a thin proxy: tool definitions and all behaviour live in the extension,
// so an MCP server built from any version keeps working against a newer extension.

/** Bumped only for breaking changes to the messages below. */
export const PROTOCOL_VERSION = 1;

/** Name under which the MCP server is registered with agents. Tools show up as `mcp__copane__<tool>`. */
export const MCP_SERVER_NAME = 'copane';

export const Methods = {
  /** MCP server → bridge. Must be the first request on a connection. */
  hello: 'hello',
  /** MCP server → bridge. */
  listTools: 'tools/list',
  /** MCP server → bridge. */
  callTool: 'tools/call',
  /** Either direction, request. */
  ping: 'ping',
  /** Either direction, notification: `{ id }` of the request to abort. */
  cancel: '$/cancel',
  /** Bridge → MCP server, notification: the tool list changed, re-fetch it. */
  toolsChanged: 'tools/changed',
} as const;

export type AgentKind = 'claude-code' | 'codex' | 'copilot' | 'other';

export interface HelloParams {
  protocolVersion: number;
  /** Secret from the instance file. Proves the caller can read the user's files. */
  token: string;
  /**
   * Stable identity of the agent session. Reconnecting with the same key (after a window reload or a
   * dropped socket) resumes the session with its tabs, terminals, label and color.
   */
  sessionKey: string;
  client: {
    /** `clientInfo.name` from the MCP initialize request, e.g. "claude-code". */
    name: string;
    version?: string;
    kind: AgentKind;
  };
  process: {
    pid: number;
    cwd: string;
  };
  /** How the MCP server found this window. Shown in diagnostics. */
  matchedBy: InstanceMatch;
}

/**
 * - `ancestor`: an ancestor process is the window's extension host (an extension started the agent).
 * - `env`: `COPANE_INSTANCE` from an integrated terminal of the window.
 * - `reconnect`: the window this server was connected to was reloaded; same workspace folders.
 * - `cwd`: the working directory is inside one of the window's workspace folders.
 * - `worktree`: the working directory is in a git worktree whose main checkout is in one of the
 *   window's workspace folders (agents often work in a worktree outside every workspace folder).
 * - `single`: the only open window.
 * - `explicit`: the agent chose the window (`window_select`).
 */
export type InstanceMatch = 'env' | 'ancestor' | 'cwd' | 'worktree' | 'single' | 'explicit' | 'reconnect';

export interface HelloResult {
  protocolVersion: number;
  extensionVersion: string;
  session: SessionDescriptor;
  window: WindowDescriptor;
  /** Usage guidance the MCP server passes to the agent as MCP `instructions`. */
  instructions: string;
}

export interface SessionDescriptor {
  id: string;
  /** Human-readable, unique within the window, e.g. "Claude 2". */
  label: string;
  /** At most two characters, e.g. "C2". Used for tab badges. */
  badge: string;
  /** Color id from the session palette, e.g. "blue". */
  color: string;
}

export interface WindowDescriptor {
  instanceId: string;
  workspaceName: string | null;
  workspaceFolders: string[];
  /** `vscode.env.remoteName`: "wsl", "ssh-remote", "dev-container", ... or null for a local window. */
  remoteName: string | null;
  platform: NodeJS.Platform;
}

export interface WireTool {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema (draft 2020-12) of the arguments object. */
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/** MCP tool annotations (hints for the client's permission UI). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ListToolsResult {
  tools: WireTool[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Same shape as MCP content blocks, so the MCP server forwards them unchanged. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface CallToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** One file per live VS Code window in `<bridge home>/instances/<id>.json`, mode 0600. */
export interface InstanceInfo {
  /** Equals the extension host pid as a string. */
  id: string;
  /** Extension host process id. Agents spawned by an extension in this window are its descendants. */
  pid: number;
  socketPath: string;
  token: string;
  protocolVersion: number;
  extensionVersion: string;
  workspaceName: string | null;
  /** File-system paths as seen by the extension host (so WSL paths inside WSL). */
  workspaceFolders: string[];
  remoteName: string | null;
  appName: string;
  startedAt: number;
  /** Updated whenever the window gains focus. Breaks ties when several windows match a cwd. */
  lastFocusedAt: number;
}

/** Environment variables understood by the MCP server and the extension. */
export const Env = {
  /** Overrides the bridge home directory (default `~/.copane`). Used by tests and dev hosts. */
  home: 'COPANE_HOME',
  /** Instance id to connect to. Set by the extension in every integrated terminal of its window. */
  instance: 'COPANE_INSTANCE',
  /** Explicit session key, instead of the agent's own session id or a random one. */
  sessionKey: 'COPANE_SESSION',
} as const;

export const ErrorCodes = {
  unauthorized: -32001,
  protocolMismatch: -32002,
  notReady: -32003,
  cancelled: -32800,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;
