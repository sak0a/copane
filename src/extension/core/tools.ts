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
      const { $schema: _ignored, additionalProperties: _closed, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
      trimSchema(inputSchema);
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

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): WireTool[] {
    return [...this.tools.values()].map(t => t.wire);
  }

  /** Never throws: failures become `isError` results with a message the agent can act on. */
  async call(name: string, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);
    const unknown = unknownArgumentsMessage(name, Object.keys(tool.definition.input), rawArgs);
    if (unknown) return errorResult(unknown);
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

/**
 * Arguments a tool does not take would otherwise be dropped without a word, and the call would do
 * something else than the agent meant. The check is on the top-level names only (nested objects
 * still drop unknown fields) and done here rather than with a strict zod object, so the message can
 * list the valid names; the advertised schema stays the same. `_meta` is MCP's own field and never
 * an argument.
 */
export function unknownArgumentsMessage(name: string, valid: readonly string[], rawArgs: unknown): string | undefined {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return undefined;
  const known = new Set(valid);
  const unknown = Object.keys(rawArgs).filter(key => key !== '_meta' && !known.has(key));
  if (unknown.length === 0) return undefined;
  const loose = (key: string) => key.toLowerCase().replace(/[_-]/g, '');
  const hints = unknown.flatMap(key => {
    const match = valid.find(v => loose(v) === loose(key));
    return match ? [`"${key}" is "${match}"`] : [];
  });
  const list = (keys: readonly string[]) => keys.map(k => `"${k}"`).join(', ');
  return (
    `${name} has no argument${unknown.length > 1 ? 's' : ''} ${list(unknown)}; nothing was done. ` +
    (valid.length ? `Its arguments are ${list(valid)}.` : 'It takes no arguments.') +
    (hints.length ? ` (${hints.join(', ')}.)` : '') +
    ' Call it again with only those.'
  );
}

/** Keywords whose value maps names to schemas: the names are parameter names, not keywords. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
/** Keywords whose value is data, not a schema. */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'required']);
const LOWER_BOUNDS = ['minimum', 'minLength', 'minItems'] as const;

/**
 * Removes from the advertised schema what tells the agent little: the safe-integer bounds zod adds
 * to `.int()` fields, lower bounds (`minimum`, `minLength`, `minItems`: when a call breaks one, the
 * zod check's message names the field and the bound), nested `additionalProperties: false` (the
 * top-level one is dropped above) and the `propertyNames: { type: "string" }` of records. Upper
 * bounds stay: a model plans with them. The zod schema still validates all of it. Tool definitions
 * are part of every conversation, so every character counts.
 */
function trimSchema(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(trimSchema);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.maximum === Number.MAX_SAFE_INTEGER) delete n.maximum;
  for (const key of LOWER_BOUNDS) if (typeof n[key] === 'number') delete n[key];
  if (n.additionalProperties === false) delete n.additionalProperties;
  const names = n.propertyNames;
  if (names && typeof names === 'object' && Object.keys(names).length === 1 && (names as { type?: unknown }).type === 'string') delete n.propertyNames;
  for (const [key, value] of Object.entries(n)) {
    if (DATA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === 'object') Object.values(value).forEach(trimSchema);
    else trimSchema(value);
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
