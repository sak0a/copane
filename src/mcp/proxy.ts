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
import { conversationIdOf, type ConversationBridges } from './conversations';

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
      'Shows which VS Code window this session is connected to (or why none) and lists the open windows. Call it when browser_* or terminal_* tools are missing or not connected.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'window_select',
    title: 'Use another VS Code window',
    description:
      'Connects this session to another open VS Code window, when the one you work in was not found automatically. Your tabs and terminals in the previous window stay there.',
    inputSchema: {
      type: 'object',
      properties: { window: { type: 'string', description: 'Id from window_status, or the workspace name.' } },
      required: ['window'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
];
const LOCAL_NAMES = new Set(LOCAL_TOOLS.map(t => t.name));

export interface ProxyOptions {
  version: string;
  /** How long `initialize` waits for a window, so the instructions can describe it. */
  initWaitMs: number;
  /** One session per chat conversation for calls that name one (VS Code); without it, all share `bridge`. */
  conversations?: ConversationBridges;
}

/** Usage guidance, fixed at `initialize`: from the window when connected by then, generic otherwise. */
export function buildInstructions(bridge: BridgeClient): string {
  const connection = bridge.current;
  const lines = [connection?.hello.instructions?.trim() || GENERIC_INSTRUCTIONS, bridge.connectionSummary()];
  if (!connection) {
    lines.push('The browser and terminal tools appear once this session is connected; no restart is needed.');
  }
  lines.push('Wrong window? Call window_status, then window_select.');
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

  // A call that names its chat conversation (VS Code's own MCP client) goes through that
  // conversation's session; every other call through the process's one session, as always.
  const conversations = options.conversations;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<any> => {
    const conversationId = conversations ? conversationIdOf(request.params._meta) : undefined;
    if (conversations && conversationId) {
      return conversations.use(conversationId, async conversation => {
        conversation.client = bridge.client;
        const result = await handleCall(conversation, request.params, extra.signal);
        if (request.params.name === 'window_select' && !result.isError) conversations.preferredWindow = conversation.current?.instance.id;
        return result;
      });
    }
    const result = await handleCall(bridge, request.params, extra.signal);
    if (conversations && request.params.name === 'window_select' && !result.isError) conversations.preferredWindow = bridge.current?.instance.id;
    return result;
  });

  return server;
}

async function handleCall(bridge: BridgeClient, params: { name: string; arguments?: Record<string, unknown> }, signal: AbortSignal): Promise<CallToolResult> {
  const { name } = params;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (name === 'window_status') {
    await bridge.ensure(0);
    return text(await statusText(bridge));
  }
  if (name === 'window_select') {
    if (typeof args.window !== 'string' || !args.window.trim()) return text('Pass `window`: a window id from window_status.', true);
    const result = await bridge.select(args.window);
    return text(result.text, !result.ok);
  }
  return bridge.call(name, args, signal);
}

/**
 * `window_status`: the connection, and why there are no browser_* tools when the window lists none
 * (the extension does not list them while VS Code's integrated browser is not enabled for it).
 */
async function statusText(bridge: BridgeClient): Promise<string> {
  const status = bridge.statusText();
  if (!bridge.current) return status;
  const tools = await bridge.listTools();
  if (tools.length === 0 || tools.some(t => t.name.startsWith('browser_'))) return status;
  // No browser tools can also mean the user's settings turned them all off: the window's own
  // instructions say which it is.
  if (!bridge.current.hello.instructions?.includes('integrated browser is not enabled')) return status;
  return `${status}\n${BROWSER_NOT_ENABLED}`;
}

const BROWSER_NOT_ENABLED =
  'The integrated browser is not enabled in this VS Code, so there are no browser_* tools. Ask the user to run the command "Copane: Enable Integrated Browser", then quit and start VS Code again (reloading the window is not enough).';

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
