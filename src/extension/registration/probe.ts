// Starts the MCP server exactly as an agent's registration says (command, args, env) and checks that
// it works: an MCP handshake and a tool list over stdio (with `--no-connect`, so no agent session
// appears in the user's window), that it ends when its stdin closes, and `--diagnose` for which
// window it would reach. Free of `copane`, so it is unit-tested with stand-in servers.
import { execFile, spawn } from 'node:child_process';

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ProbeOptions {
  /** The environment the agent's own process would pass on (the registration's env is added). */
  baseEnv: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
}

export interface HandshakeResult {
  ok: boolean;
  /** One sentence: what worked, or the step that failed and how. */
  text: string;
  /** The server's name and version from `initialize`. */
  server?: string;
  tools?: string[];
  /** Exit code when the process ended on its own (before or after stdin closed). */
  exitCode?: number | null;
  /** The process did not end within a few seconds of its stdin closing. */
  lingered?: boolean;
  stderr: string;
  ms: number;
}

const MAX_STDERR = 4000;
/** Any version the server's MCP SDK supports; it answers with the one it uses. Not imported from the SDK, which would add it to the extension bundle. */
const PROTOCOL_VERSION = '2025-06-18';

/** The environment an agent gives the server: its own, plus the registration's `env`. */
export function childEnv(launch: Launch, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // The extension host runs with these; an agent normally does not, and they would change what is tested.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.COPANE_INSTANCE;
  delete env.COPANE_SESSION;
  return { ...env, ...launch.env };
}

export function handshake(launch: Launch, options: ProbeOptions): Promise<HandshakeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise(resolve => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    let initialized: { server: string } | undefined;
    let tools: string[] | undefined;
    let stdinClosedAt: number | undefined;
    const finish = (result: Omit<HandshakeResult, 'stderr' | 'ms'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve({ ...result, stderr: stderr.trim().slice(-MAX_STDERR), ms: Date.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launch.command, [...launch.args, '--no-connect'], { env: childEnv(launch, options.baseEnv), cwd: options.cwd, stdio: 'pipe', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, text: `${launch.command} could not be started: ${err instanceof Error ? err.message : String(err)}`, stderr: '', ms: Date.now() - started });
      return;
    }
    const timer = setTimeout(() => {
      const step = !initialized ? 'did not answer the MCP handshake (initialize)' : !tools ? 'did not answer tools/list' : 'did not end after its input was closed';
      finish({ ok: false, text: `the server ${step} within ${Math.round(timeoutMs / 1000)} s`, ...(initialized ? initialized : {}), ...(tools ? { tools } : {}) });
    }, timeoutMs);
    child.on('error', err => finish({ ok: false, text: `${launch.command} could not be started: ${err.message}` }));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-MAX_STDERR * 2)));
    child.stdin!.on('error', () => {}); // EPIPE when the process is already gone; reported through 'exit'.
    child.on('exit', (code, signal) => {
      if (stdinClosedAt !== undefined) {
        finish({ ok: true, text: `answered the MCP handshake and listed ${tools!.length} tools, and ended when its input closed`, ...initialized!, tools, exitCode: code });
        return;
      }
      const when = !initialized ? 'before answering the MCP handshake' : !tools ? 'before answering tools/list' : 'while its input was still open';
      finish({ ok: false, text: `the server exited ${when} (${signal ? `signal ${signal}` : `exit code ${code}`})`, ...(initialized ?? {}), ...(tools ? { tools } : {}), exitCode: code });
    });
    const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      for (let nl = stdout.indexOf('\n'); nl >= 0; nl = stdout.indexOf('\n')) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, text: `the server wrote something that is not MCP to stdout: ${line.slice(0, 200)}` });
          return;
        }
        if (message.id === 1) {
          if (message.error) return finish({ ok: false, text: `initialize failed: ${message.error.message}` });
          const info = message.result?.serverInfo;
          initialized = { server: `${info?.name ?? '?'} ${info?.version ?? '?'}` };
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (message.error) return finish({ ok: false, text: `tools/list failed: ${message.error.message}`, ...initialized! });
          tools = (message.result?.tools ?? []).map((t: { name: string }) => t.name);
          // An agent ends a session by closing the server's stdin; the server must exit then.
          stdinClosedAt = Date.now();
          child.stdin!.end();
          setTimeout(() => finish({ ok: true, text: `answered the MCP handshake and listed ${tools!.length} tools, but kept running after its input closed`, ...initialized!, tools, lingered: true }), 5000).unref?.();
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'copane-check', version: '1' } },
    });
  });
}

export interface DiagnoseResult {
  ok: boolean;
  text: string;
  /** The parsed `--diagnose` report, when there was one. */
  report?: any;
  stderr: string;
}

/** Runs `<command> <args> --diagnose` and says whether it finds (and reaches) window `windowId`. */
export function diagnose(launch: Launch, options: ProbeOptions & { windowId: string }): Promise<DiagnoseResult> {
  return new Promise(resolve => {
    execFile(
      launch.command,
      [...launch.args, '--diagnose'],
      { env: childEnv(launch, options.baseEnv), cwd: options.cwd, timeout: options.timeoutMs ?? 30_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const errText = (stderr ?? '').trim().slice(-MAX_STDERR);
        if (err && !stdout) {
          resolve({ ok: false, text: `${launch.command} could not be started: ${(stderr || err.message).trim().split(/\r?\n/)[0]}`, stderr: errText });
          return;
        }
        let report: any;
        try {
          report = JSON.parse(stdout);
        } catch {
          resolve({ ok: false, text: `unexpected output: ${stdout.slice(0, 200)}`, stderr: errText });
          return;
        }
        const runtime = `runs on ${report.runtime?.execPath} (Node ${report.runtime?.node}), server ${report.version}`;
        const ancestry = report.ancestry ? `; process lookup: ${report.ancestry.method} in ${report.ancestry.ms} ms${report.ancestry.errors?.length ? ` (${report.ancestry.errors.join('; ')})` : ''}` : '';
        const ping = report.ping ? (report.ping.ok ? `, and the window answers (${report.ping.ms} ms)` : `, but the window does not answer: ${report.ping.error}`) : '';
        if (report.selected?.id === options.windowId) {
          resolve({ ok: !report.ping || report.ping.ok, text: `${runtime}; finds this window (matched by ${report.selected.matchedBy})${ping}${ancestry}.`, report, stderr: errText });
        } else if (report.selected) {
          resolve({ ok: false, text: `${runtime}; but connects to window ${report.selected.id} instead of this one (matched by ${report.selected.matchedBy})${ancestry}.`, report, stderr: errText });
        } else {
          resolve({ ok: false, text: `${runtime}; but finds no window: ${report.problem}${ancestry}`, report, stderr: errText });
        }
      },
    );
  });
}
