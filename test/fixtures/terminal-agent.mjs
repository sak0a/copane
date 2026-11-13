// An agent session whose process runs inside an integrated terminal, the way `claude` started in a
// terminal does. ui-panel.e2e.mjs starts it with terminal_run, so the terminal's shell is an ancestor
// of this session's MCP server. Prints "ready <tab id>" and stays connected until interrupted.
//
//   node test/fixtures/terminal-agent.mjs --name <dev host> --session <key> --url <page url>
import { agent } from '../e2e/harness.mjs';

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1];
const session = await agent({ session: arg('session') });
await session.ok('session_set_title', { title: 'in a terminal' });
const opened = await session.ok('browser_open', { url: arg('url'), background: true });
console.log(`ready ${/tab-\d+/.exec(opened)?.[0]}`);
process.on('SIGINT', () => session.close().finally(() => process.exit(0)));
await new Promise(() => {});
