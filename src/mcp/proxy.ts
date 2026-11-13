// The MCP side of the MCP server: answers the agent over MCP, forwards tools to the window's bridge,
// and adds two tools of its own that work without a window (`window_status`, `window_select`), so an
// agent that is not connected gets an explanation and a way out instead of an empty tool list.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  type InitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_SERVER_NAME, type CallToolResult, type WireTool } from '../shared/protocol';
import type { BridgeClient } from './bridgeClient';

/** Claude Code cuts server instructions after 4096 characters. */
const MAX_INSTRUCTIONS = 4000;

const GENERIC_INSTRUCTIONS =
  'These tools operate on the VS Code window you are running in: its integrated browser tabs (browser_*) and integrated terminals (terminal_*). ' +
  'The user sees everything you do there and can step in at any time.';

export const LOCAL_TOOLS: WireTool[] = [
  {
    name: 'window_status',
    title: 'VS Code window status',
    description:
      'Shows which VS Code window this session is connected to and why, or why it is not connected, and lists the open VS Code windows. ' +
      'Call it when the browser_* or terminal_* tools are missing or report that they are not connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'window_select',
    title: 'Use another VS Code window',
    description:
      'Connects this session to a different open VS Code window, for when several windows are open and the one you work in was not found automatically. ' +
      'Pass the window id from window_status (or its workspace name). Your browser tabs and terminals in the previous window stay there.',
    inputSchema: {
      type: 'object',
      properties: { window: { type: 'string', description: 'Window id from window_status, or the workspace name.' } },
      required: ['window'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const LOCAL_NAMES = new Set(LOCAL_TOOLS.map(t => t.name));

export interface ProxyOptions {
  version: string;
  /** How long `initialize` waits for a window, so the instructions can describe it. */
  initWaitMs: number;
}

/** Usage guidance, fixed at `initialize`: from the window when connected by then, generic otherwise. */
export function buildInstructions(bridge: BridgeClient): string {
  const connection = bridge.current;
  const lines = [connection?.hello.instructions?.trim() || GENERIC_INSTRUCTIONS, bridge.connectionSummary()];
  if (!connection) {
    lines.push('The browser and terminal tools appear once this session is connected; no restart is needed.');
  }
  lines.push('window_status shows which VS Code window this session uses and lists the others; window_select switches to another.');
  const text = lines.join('\n');
  return text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS - 1)}…` : text;
}

export function createProxyServer(bridge: BridgeClient, options: ProxyOptions): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: options.version }, { capabilities: { tools: { listChanged: true } } });

  // `instructions` are only sent in the initialize response, before any tool call. Connecting first
  // (briefly) lets them say which window and session this is. The SDK's own handler records the
  // client's info and capabilities, so it still runs; only the instructions are added.
  const sdkInitialize = (server as unknown as { _oninitialize?: (request: InitializeRequest) => Promise<Record<string, unknown>> })._oninitialize;
  server.setRequestHandler(InitializeRequestSchema, async request => {
    const info = request.params.clientInfo;
    bridge.client = { name: info?.name ?? 'unknown', ...(info?.version ? { version: info.version } : {}) };
    // Bounded even when a window accepts the socket but answers slowly.
    await Promise.race([bridge.ensure(options.initWaitMs), new Promise(resolve => setTimeout(resolve, options.initWaitMs).unref?.())]);
    bridge.start();
    const result =
      typeof sdkInitialize === 'function'
        ? await sdkInitialize.call(server, request)
        : { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } }, serverInfo: { name: MCP_SERVER_NAME, version: options.version } };
    return { ...result, instructions: buildInstructions(bridge) } as any;
  });

  // Not before the handshake is complete: the client lists the tools right after it anyway.
  let initialized = false;
  server.oninitialized = () => {
    initialized = true;
  };
  bridge.onToolsChanged = () => {
    if (initialized) void server.sendToolListChanged().catch(() => {});
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const remote = (await bridge.listTools()).filter(t => !LOCAL_NAMES.has(t.name));
    return { tools: [...remote, ...LOCAL_TOOLS] as any };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<any> => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (name === 'window_status') {
      await bridge.ensure(0);
      return text(bridge.statusText());
    }
    if (name === 'window_select') {
      if (typeof args.window !== 'string' || !args.window.trim()) return text('Pass `window`: a window id from window_status.', true);
      const result = await bridge.select(args.window);
      return text(result.text, !result.ok);
    }
    return bridge.call(name, args, extra.signal);
  });

  return server;
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
