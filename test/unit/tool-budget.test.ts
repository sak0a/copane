// What the tool definitions cost every conversation, with a budget so the cost cannot creep up
// unnoticed. The tools are collected the way the extension registers them (the modules' own activate
// functions, against a stand-in for `vscode`), plus the two tools the MCP server adds itself, and
// measured as the agent receives them: the JSON of each definition (name, title, description, input
// schema, annotations). `node scripts/measure-tokens.mjs copane` measures the same list on a dev host.
//
// When a budget fails, shorten the wording first (see "Tool definitions cost context" in
// docs/ARCHITECTURE.md). Raise a budget only for a tool or feature worth its cost, in the same change.
import { describe, expect, it, vi } from 'vitest';

/** Characters of all tool definitions together (about 3.6 characters per token). */
const TOTAL_BUDGET = 30_000;
/** Characters of any one tool definition. */
const PER_TOOL_BUDGET = 1_800;
/**
 * Characters of the extension's instructions (core/instructions.ts). Claude Code cuts the server's
 * instructions at 4096 characters, and the MCP server adds a few lines about the connection.
 */
const INSTRUCTIONS_BUDGET = 3_400;

vi.mock('vscode', () => {
  const api = anything('vscode');
  return new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : api[key]), has: () => true });
});

/**
 * A value that is every API at once: any property is another such value, calling or constructing one
 * returns another, iterating one yields nothing. Enough for the modules to activate; nothing runs.
 */
function anything(path: string): any {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(function () {}, {
    get(_t, key) {
      if (key === 'then' || key === Symbol.asyncIterator) return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => '';
      if (!cache.has(key)) cache.set(key, anything(`${path}.${String(key)}`));
      return cache.get(key);
    },
    apply: () => anything(`${path}()`),
    construct: () => anything(`new ${path}`),
    has: () => true,
  });
}

interface Measured {
  tools: Array<{ name: string; chars: number }>;
  total: number;
  instructions: { browserAvailable: number; browserMissing: number };
}

/** The tool list and instructions of a production window, as an agent receives them. */
async function measure(): Promise<Measured> {
  const { ToolRegistry } = await import('../../src/extension/core/tools');
  const { SessionManager } = await import('../../src/extension/core/sessions');
  const { LeaseManager } = await import('../../src/extension/core/leases');
  const { activateSessionTools } = await import('../../src/extension/core/sessionTools');
  const { activateBrowser } = await import('../../src/extension/browser');
  const { activateTerminals } = await import('../../src/extension/terminal');
  const { buildInstructions } = await import('../../src/extension/core/instructions');
  const { LOCAL_TOOLS } = await import('../../src/mcp/proxy');
  const subscriptions: Array<{ dispose(): unknown }> = [];
  const services: any = {
    // extensionMode 1 = Production: no debug_* tools.
    context: Object.assign(anything('context'), { subscriptions, extensionMode: 1 }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    window: { instanceId: 'test', workspaceName: 'test', workspaceFolders: [] },
    sessions: new SessionManager(),
    tools: new ToolRegistry(),
    prompts: { ask: async () => undefined, input: async () => undefined },
    tabLeases: new LeaseManager(),
    browser: undefined,
    terminals: undefined,
  };
  try {
    activateSessionTools(services);
    activateBrowser(services);
    activateTerminals(services);
    const tools = [...services.tools.list(), ...LOCAL_TOOLS].map(t => ({ name: t.name as string, chars: JSON.stringify(t).length }));
    const instructions = (available: boolean) => buildInstructions({ ...services, browser: { ...services.browser, available } }).length;
    return {
      tools,
      // As in measure-tokens.mjs: the JSON array of all definitions.
      total: tools.reduce((n, t) => n + t.chars, 0) + tools.length + 1,
      instructions: { browserAvailable: instructions(true), browserMissing: instructions(false) },
    };
  } finally {
    for (const s of subscriptions.reverse()) {
      try {
        s.dispose();
      } catch {
        // A stand-in.
      }
    }
  }
}

const ADVICE =
  'Shorten the wording: the first sentence says what the tool is for; describe a parameter only where its name and type do not say it; ' +
  'guidance shared by several tools goes once into core/instructions.ts. Raise the budget in test/unit/tool-budget.test.ts only for a tool worth its cost.';

describe('tool definition budget', () => {
  it('keeps every tool and the whole list within budget', async () => {
    const m = await measure();
    expect(m.tools.length, 'no tools were collected: did a module change how it registers its tools?').toBeGreaterThan(20);
    const largest = [...m.tools].sort((a, b) => b.chars - a.chars);
    const summary = `${m.tools.length} tools, ${m.total} chars (≈ ${Math.round(m.total / 3.6)} tokens); largest: ${largest
      .slice(0, 6)
      .map(t => `${t.name} ${t.chars}`)
      .join(', ')}`;
    console.log(`Tool definitions: ${summary}. Instructions: ${m.instructions.browserAvailable} chars (${m.instructions.browserMissing} without the browser).`);

    const over = largest.filter(t => t.chars > PER_TOOL_BUDGET);
    expect(over.map(t => `${t.name}: ${t.chars} chars`), `These tool definitions are over the ${PER_TOOL_BUDGET}-character budget per tool. ${ADVICE}`).toEqual([]);
    expect(m.total, `All tool definitions together are ${m.total} characters, over the budget of ${TOTAL_BUDGET} (${summary}). ${ADVICE}`).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it('keeps the instructions within budget', async () => {
    const { instructions } = await measure();
    const longest = Math.max(instructions.browserAvailable, instructions.browserMissing);
    expect(
      longest,
      `core/instructions.ts produces ${longest} characters, over the budget of ${INSTRUCTIONS_BUDGET}: Claude Code drops what is past 4096 characters, and the MCP server adds its own lines. Keep only guidance that several tools share.`,
    ).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
  });
});
