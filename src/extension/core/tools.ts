// Tool definitions and the registry the bridge server dispatches to. Every MCP tool the agent sees is
// defined in the extension with `defineTool` and registered here by its module.
import { z } from 'zod';
import type { CallToolResult, ToolAnnotations, ToolContent, WireTool } from '../../shared/protocol';
import { ToolError } from './errors';
import { Emitter, type Disposable, type Event } from './events';
import type { Logger } from './log';
import type { AgentSession } from './sessions';

export interface ToolContext {
  /** The agent session making the call. */
  session: AgentSession;
  /** Aborted when the agent cancels the call or disconnects. Long-running tools must honour it. */
  signal: AbortSignal;
  log: Logger;
}

/** What a handler may return: a string (one text block), content blocks, or a full result. */
export type ToolOutput = string | ToolContent[] | CallToolResult;

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case, prefixed by its area: `browser_*`, `terminal_*`, `session_*`. */
  name: string;
  title?: string;
  /** Written for the agent: what the tool does, when to use it, what it returns. */
  description: string;
  /** Zod shape of the arguments object. Describe every field with `.describe(...)`. */
  input: Shape;
  annotations?: ToolAnnotations;
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolOutput> | ToolOutput;
}

/** Identity function that infers the handler's argument types from `input`. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}

export const text = (value: string): ToolContent => ({ type: 'text', text: value });

export const image = (base64: string, mimeType = 'image/png'): ToolContent => ({ type: 'image', data: base64, mimeType });

/** Compact JSON text block, for structured results the agent should read as data. */
export const json = (value: unknown): ToolContent => ({ type: 'text', text: JSON.stringify(value, null, 2) });

interface Registered {
  definition: ToolDefinition<any>;
  schema: z.ZodObject<any>;
  wire: WireTool;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Registered>();
  private readonly changeEmitter = new Emitter<void>();

  /** Fires when tools are added or removed, so connected MCP servers can refresh their list. */
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  register(definitions: ReadonlyArray<ToolDefinition<any>>): Disposable {
    // Build every entry first, so a bad definition leaves the registry unchanged.
    const batch = new Map<string, Registered>();
    for (const definition of definitions) {
      if (this.tools.has(definition.name) || batch.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
      const schema = z.object(definition.input);
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
      batch.set(definition.name, {
        definition,
        schema,
        wire: {
          name: definition.name,
          title: definition.title,
          description: definition.description,
          inputSchema,
          annotations: definition.annotations,
        },
      });
    }
    for (const [name, entry] of batch) this.tools.set(name, entry);
    this.changeEmitter.fire();
    return {
      dispose: () => {
        for (const definition of definitions) this.tools.delete(definition.name);
        this.changeEmitter.fire();
      },
    };
  }

  list(): WireTool[] {
    return [...this.tools.values()].map(t => t.wire);
  }

  /** Never throws: failures become `isError` results with a message the agent can act on. */
  async call(name: string, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) return errorResult(`Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}`);
    try {
      return normalize(await tool.definition.handler(parsed.data, ctx));
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      if (ctx.signal.aborted) return errorResult('Cancelled.');
      ctx.log.error(`tool ${name} failed`, err);
      return errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function normalize(output: ToolOutput): CallToolResult {
  if (typeof output === 'string') return { content: [text(output)] };
  if (Array.isArray(output)) return { content: output };
  return output;
}

function errorResult(message: string): CallToolResult {
  return { content: [text(message)], isError: true };
}
