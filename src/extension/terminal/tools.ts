// The terminal_* tools. Results are written for a model: what happened, the rendered output (cut
// deliberately), what the terminal is doing now, and what to call next.
import { z } from 'zod';
import { ToolError } from '../core/errors';
import type { BridgeServices } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { defineTool, type ToolContext, type ToolDefinition } from '../core/tools';
import { describeInput, encodeKeys, KeyError } from './keys';
import { raceTimeout, sleep, type Execution, type HandoffOutcome, type TerminalManager, type Tracked } from './manager';
import { clipLines, DEFAULT_MAX_CHARS, formatClip, formatDuration, MAX_MAX_CHARS, shortCommand } from './render';

/** Without it, tools act on the session's current terminal (said once, in instructions.ts). */
const terminalArg = z.string().optional();
const maxCharsArg = z
  .number()
  .int()
  .min(500)
  .max(MAX_MAX_CHARS)
  .optional()
  .describe(`Default ${DEFAULT_MAX_CHARS}.`);

export function terminalTools(services: BridgeServices, manager: TerminalManager): ToolDefinition<any>[] {
  // ---------------------------------------------------------------- helpers

  const isBusy = (t: Tracked) => !!t.current || !!t.handoff;

  function byId(id: string): Tracked {
    const t = manager.find(id);
    if (t && !t.closed) return t;
    const ids = manager.all().map(x => x.id);
    throw new ToolError('not_found', `There is no open terminal "${id}"${t?.closed ? ' any more: it was closed' : ''}. Open terminals: ${ids.join(', ') || 'none'}. terminal_list shows them all.`);
  }

  /** The terminal a reading or input tool acts on. */
  async function existing(ctx: ToolContext, id: string | undefined): Promise<Tracked> {
    await manager.ready;
    if (id) {
      const t = byId(id);
      await manager.ensureAccess(ctx.session, t, ctx.signal);
      return t;
    }
    const t = manager.currentFor(ctx.session);
    if (!t) throw new ToolError('not_found', 'You have no terminal yet. terminal_run creates one when it runs your first command (or call terminal_create).');
    return t;
  }

  /** The terminal a new command goes to: the given one, or a free one of the session's own. */
  async function forCommand(ctx: ToolContext, id: string | undefined): Promise<{ t: Tracked; note: string | undefined }> {
    await manager.ready;
    if (id) {
      const t = byId(id);
      await manager.ensureAccess(ctx.session, t, ctx.signal);
      if (isBusy(t)) throw busyError(t, ctx.session);
      manager.setCurrent(ctx.session, t);
      return { t, note: undefined };
    }
    const current = manager.currentFor(ctx.session);
    if (current && !isBusy(current)) return { t: current, note: undefined };
    const free = manager.ownedBy(ctx.session.id).find(x => !isBusy(x));
    if (free) {
      manager.setCurrent(ctx.session, free);
      return { t: free, note: current ? `${current.id} is busy (${doing(current)}), so this runs in ${free.id} ("${free.name}").` : undefined };
    }
    const created = await manager.create(ctx.session, {});
    const note = current
      ? `${current.id} is busy (${doing(current)}), so I opened a new terminal ${created.id} ("${created.name}") for this.`
      : `Opened terminal ${created.id} ("${created.name}") for you; it is visible to the user in the terminal panel.`;
    return { t: created, note };
  }

  function by(session: AgentSession, sessionId: string | undefined): string {
    if (!sessionId) return 'the user';
    if (sessionId === session.id) return 'you';
    return services.sessions.get(sessionId)?.label ?? 'an earlier agent session';
  }

  function doing(t: Tracked): string {
    if (t.handoff) return `waiting for the user: "${t.handoff.message}"`;
    if (t.current) return `running \`${shortCommand(t.current.commandLine)}\` for ${formatDuration(Date.now() - t.current.startedAt)}`;
    return t.state;
  }

  function busyError(t: Tracked, session: AgentSession): ToolError {
    if (t.handoff) {
      const mine = t.handoff.sessionId === session.id;
      return new ToolError(
        'busy',
        `${t.id} is waiting for the user${mine ? ' to finish your request' : ''} ("${t.handoff.message}"). Do not type into it meanwhile${mine ? '; terminal_request_user_input returns when they are done' : ''}. Use another terminal for other work.`,
      );
    }
    const c = t.current!;
    return new ToolError(
      'busy',
      `${t.id} is busy: \`${shortCommand(c.commandLine)}\` (started by ${by(session, c.agentSession)}) has been running for ${formatDuration(Date.now() - c.startedAt)}. ` +
        `Wait for it (terminal_wait), give it input (terminal_send), stop it (terminal_interrupt), or omit \`terminal\` to run in a free terminal of your own.`,
    );
  }

  const readCall = (t: Tracked, fromLine: number) => `terminal_read {"terminal":"${t.id}","what":"command","from_line":${fromLine}}`;

  function statusOf(t: Tracked): string {
    if (t.closed) return `${t.id} has been closed.`;
    if (t.handoff) return `${t.id} is waiting for the user: "${t.handoff.message}".`;
    if (t.current) return `${t.id} is running \`${shortCommand(t.current.commandLine)}\` (for ${formatDuration(Date.now() - t.current.startedAt)}). ${manager.activity(t).summary}`;
    const last = t.last ? ` Last command \`${shortCommand(t.last.commandLine)}\`${t.last.exitCode !== undefined ? ` exited with ${t.last.exitCode}` : ' finished'}.` : '';
    return `${t.id} is idle at the prompt.${last}`;
  }

  /** Joins result parts; adds what is degraded in this terminal the first time a session uses it. */
  function withNotes(t: Tracked, parts: Array<string | undefined>, session?: AgentSession): string {
    const notes = session && t.limitationsShown.has(session.id) ? [] : manager.limitations(t);
    if (session && notes.length) t.limitationsShown.add(session.id);
    return [...parts, ...notes.map(n => `Note: ${n}`)].filter(p => p !== undefined && p !== '').join('\n');
  }

  function outputBlock(t: Tracked, execution: Execution, maxChars: number | undefined): string {
    const { lines, startLost } = manager.outputOf(t, execution);
    return formatClip(clipLines(lines, { maxChars }), from => readCall(t, from), { startLost });
  }

  function newOutputBlock(t: Tracked, session: AgentSession, maxChars: number | undefined): string {
    const { lines, startLost } = manager.readNew(session, t);
    if (lines.length === 0) return '(no new output)';
    // Cut new output is still part of the command's output, which can be paged from its start.
    const more = t.current ?? t.last ? readCall(t, 1) : `terminal_read {"terminal":"${t.id}","what":"screen"}`;
    return formatClip(clipLines(lines, { maxChars }), () => more, { startLost });
  }

  /** A finished execution this session has not been told about yet. */
  function unreportedEnd(t: Tracked, session: AgentSession): Execution | undefined {
    const last = t.last;
    return last && last.ended && t.reportedEnd.get(session.id) !== last ? last : undefined;
  }

  function finishedLine(t: Tracked, execution: Execution, session?: AgentSession): string {
    if (session) t.reportedEnd.set(session.id, execution);
    const took = formatDuration((execution.endedAt ?? Date.now()) - execution.startedAt);
    const code = execution.exitCode !== undefined ? `exited with code ${execution.exitCode}` : execution.fallback ? 'finished (exit code unknown without shell integration)' : 'finished (the shell reported no exit code)';
    return `\`${shortCommand(execution.commandLine)}\` ${code} after ${took} in ${t.id}.`;
  }

  async function startCommand(ctx: ToolContext, t: Tracked, command: string): Promise<Execution | undefined> {
    const hasShellIntegration = await manager.waitForShellIntegration(t, ctx.signal);
    if (ctx.signal.aborted) throw new ToolError('cancelled', 'Cancelled.');
    if (hasShellIntegration) return manager.startWithShellIntegration(ctx.session, t, command, ctx.signal);
    return manager.startWithoutShellIntegration(ctx.session, t, command);
  }

  // ---------------------------------------------------------------- tools

  return [
    defineTool({
      name: 'terminal_run',
      title: 'Run a command in a terminal',
      description:
        'Runs a shell command in a VS Code terminal the user can watch (default: your current one, opened when needed) and returns its output and exit code. ' +
        'A command still running after timeout_seconds keeps running: continue with terminal_wait, terminal_read, terminal_send or terminal_interrupt.',
      input: {
        command: z.string().min(1).describe("As typed at the prompt of the terminal's shell."),
        terminal: terminalArg,
        timeout_seconds: z.number().min(1).max(600).optional().describe('Default 60; 5-10 for servers and watchers.'),
        max_chars: maxCharsArg,
      },
      handler: async (args, ctx) => {
        const { t, note } = await forCommand(ctx, args.terminal);
        const execution = await startCommand(ctx, t, args.command);
        if (!execution) {
          return withNotes(t, [note, `Typed \`${shortCommand(args.command)}\` into ${t.id} and pressed Enter. Its result cannot be observed here; ask the user to look at the terminal if it matters.`], ctx.session);
        }
        const waited = await raceTimeout(execution.done, (args.timeout_seconds ?? 60) * 1000, ctx.signal);
        if (waited === 'aborted') throw new ToolError('cancelled', `Cancelled. The command keeps running in ${t.id}.`);
        await t.mirror.flush();
        const block = outputBlock(t, execution, args.max_chars);
        manager.markRead(ctx.session, t, execution);
        if (execution.ended) return withNotes(t, [note, finishedLine(t, execution, ctx.session), block], ctx.session);
        return withNotes(t, [
          note,
          `\`${shortCommand(execution.commandLine)}\` is still running in ${t.id} after ${formatDuration(Date.now() - execution.startedAt)}; it keeps running.`,
          manager.activity(t).summary,
          'Output so far:',
          block,
          `Next: terminal_wait {"terminal":"${t.id}"} (until it ends, or for_text), terminal_read for new output, terminal_send to type, terminal_interrupt to stop it.`,
        ], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_read',
      title: 'Read terminal output',
      description:
        'Reads a terminal and says what it is doing. what: "new" (default) output since your last look, "command" the latest command\'s whole output, "screen" the visible screen.',
      input: {
        terminal: terminalArg,
        what: z.enum(['new', 'command', 'screen']).optional(),
        from_line: z.number().int().min(1).optional().describe('With what "command": first line (1-based), for paging.'),
        max_chars: maxCharsArg,
      },
      annotations: { readOnlyHint: true },
      handler: async (args, ctx) => {
        const t = await existing(ctx, args.terminal);
        await t.mirror.flush();
        const what = args.what ?? 'new';
        if (what === 'screen') {
          const screen = t.mirror.screen();
          const lines = screen.lines.map(l => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
          return withNotes(t, [
            `Screen of ${t.id} "${t.name}" (${screen.cols}x${screen.rows}${screen.alternate ? ', full-screen program' : ''}; cursor at row ${screen.cursor.row + 1}, column ${screen.cursor.col + 1}):`,
            lines.length ? lines.join('\n') : '(empty)',
            statusOf(t),
            manager.dimensionsAvailable ? undefined : 'Note: the real terminal size is not available (proposed API terminalDimensions not enabled), so a full-screen program may be laid out differently here.',
          ], ctx.session);
        }
        if (what === 'command') {
          const execution = t.current ?? t.last;
          if (!execution) return withNotes(t, [`No command has run in ${t.id} since the extension started watching it.`, statusOf(t)], ctx.session);
          const { lines, startLost } = manager.outputOf(t, execution);
          const clip = clipLines(lines, { maxChars: args.max_chars, fromLine: args.from_line });
          manager.markRead(ctx.session, t, execution);
          return withNotes(t, [`Output of \`${shortCommand(execution.commandLine)}\` in ${t.id}:`, formatClip(clip, from => readCall(t, from), { startLost }), statusOf(t)], ctx.session);
        }
        return withNotes(t, [`New output in ${t.id}:`, newOutputBlock(t, ctx.session, args.max_chars), statusOf(t)], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_wait',
      title: 'Wait for a terminal',
      description:
        'Waits until the terminal\'s command finishes or, with for_text, until that text appears in new output (e.g. "ready" for a dev server), and returns the new output.',
      input: {
        terminal: terminalArg,
        for_text: z.string().min(1).optional().describe('Regex or plain text, case-insensitive.'),
        timeout_seconds: z.number().min(1).max(600).optional().describe('Default 60.'),
        max_chars: maxCharsArg,
      },
      annotations: { readOnlyHint: true },
      handler: async (args, ctx) => {
        const t = await existing(ctx, args.terminal);
        const pattern = args.for_text ? toPattern(args.for_text) : undefined;
        const started = Date.now();
        const deadline = started + (args.timeout_seconds ?? 60) * 1000;
        const execution = t.current;
        if (!pattern && !execution) {
          const ended = unreportedEnd(t, ctx.session);
          const headline = ended ? `Nothing is running in ${t.id} any more: ${finishedLine(t, ended, ctx.session)}` : `Nothing is running in ${t.id}.`;
          return withNotes(t, [headline, 'New output:', newOutputBlock(t, ctx.session, args.max_chars), statusOf(t)], ctx.session);
        }
        const mark = t.marks.get(ctx.session.id);
        let found = false;
        for (;;) {
          await t.mirror.flush();
          if (pattern && pattern.test(t.mirror.linesSince(mark).lines.join('\n'))) {
            found = true;
            break;
          }
          if (!pattern && (!execution || execution.ended)) break;
          if (t.closed || ctx.signal.aborted || Date.now() >= deadline) break;
          await sleep(200);
        }
        if (ctx.signal.aborted) throw new ToolError('cancelled', 'Cancelled.');
        const took = formatDuration(Date.now() - started);
        let headline: string;
        if (found) headline = `"${args.for_text}" appeared in ${t.id} after ${took}.`;
        else if (t.closed) headline = `${t.id} was closed while waiting.`;
        else if (!pattern && execution?.ended) headline = finishedLine(t, execution, ctx.session);
        else if (pattern) headline = `"${args.for_text}" did not appear within ${took}.${t.current ? '' : ' (Nothing is running in the terminal.)'}`;
        else headline = `Still running after waiting ${took}.`;
        return withNotes(t, [headline, 'New output:', newOutputBlock(t, ctx.session, args.max_chars), statusOf(t)], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_send',
      title: 'Type into a terminal',
      description:
        'Types text and/or presses keys in a terminal, to answer a prompt or drive a menu or full-screen program, and returns the output that followed. Text is typed as is; add keys ["Enter"] to submit. Never type secrets you were not given.',
      input: {
        terminal: terminalArg,
        text: z.string().optional(),
        keys: z.array(z.string()).optional().describe('Pressed after the text, e.g. ["Down", "Enter"], ["Ctrl+C"], ["Escape"].'),
        wait_seconds: z.number().min(0).max(30).optional().describe('Longest wait for output to settle, default 2.'),
        max_chars: maxCharsArg,
      },
      handler: async (args, ctx) => {
        const t = await existing(ctx, args.terminal);
        if (t.handoff) throw busyError(t, ctx.session);
        let data: string;
        try {
          data = (args.text ?? '') + encodeKeys(args.keys ?? [], { applicationCursor: t.mirror.applicationCursorKeys });
        } catch (err) {
          if (err instanceof KeyError) throw new ToolError('invalid_input', err.message);
          throw err;
        }
        if (!data) throw new ToolError('invalid_input', 'Nothing to send: pass `text`, `keys` or both.');
        if (!t.marks.has(ctx.session.id)) t.marks.set(ctx.session.id, t.mirror.mark());
        const sentAt = Date.now();
        const before = t.mirror.received;
        t.terminal.sendText(data, false);
        const limit = sentAt + (args.wait_seconds ?? 2) * 1000;
        // Wait for the response: some output, then a short quiet period (or the limit).
        while (Date.now() < limit && !ctx.signal.aborted && !t.closed) {
          await sleep(100);
          const gotOutput = t.mirror.received > before;
          if (gotOutput && Date.now() - t.mirror.lastWriteAt >= 500) break;
        }
        await t.mirror.flush();
        return withNotes(t, [`Sent ${describeInput(args.text, args.keys)} to ${t.id}.`, 'Output since your last look:', newOutputBlock(t, ctx.session, args.max_chars), statusOf(t)], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_interrupt',
      title: 'Interrupt a terminal command',
      description: 'Presses Ctrl+C in a terminal to stop its command, waits up to 5 s for it to end, and returns the last output.',
      input: { terminal: terminalArg, max_chars: maxCharsArg },
      handler: async (args, ctx) => {
        const t = await existing(ctx, args.terminal);
        const execution = t.current;
        t.terminal.sendText('\x03', false);
        if (execution) await raceTimeout(execution.done, 5000, ctx.signal);
        else await sleep(300);
        await t.mirror.flush();
        let headline: string;
        if (!execution) headline = `Pressed Ctrl+C in ${t.id}; no command was running.`;
        else if (execution.ended) headline = `Interrupted. ${finishedLine(t, execution, ctx.session)}`;
        else headline = `Pressed Ctrl+C, but \`${shortCommand(execution.commandLine)}\` is still running after 5 s. Try again, send keys ["Ctrl+\\\\"], or close the terminal (terminal_close).`;
        return withNotes(t, [headline, 'Output since your last look:', newOutputBlock(t, ctx.session, args.max_chars), statusOf(t)], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_request_user_input',
      title: 'Hand the terminal to the user',
      description:
        'Hands a terminal to the user for what you must not or cannot do: a password, a 2FA code, a login (gh auth login, sudo ...) or a decision at a prompt. ' +
        'Optionally starts `command` first (omit it when a prompt is already waiting). Returns when it ends or the user clicks Done or Won\'t Do, with the output; what the user types stays private.',
      input: {
        message: z.string().min(1).max(300).describe('One or two sentences, e.g. "Log in to GitHub: pick HTTPS and finish in the browser."'),
        command: z.string().optional(),
        terminal: terminalArg,
        timeout_seconds: z.number().min(10).max(3600).optional().describe('Default 600.'),
        max_chars: maxCharsArg,
      },
      handler: async (args, ctx) => {
        let t: Tracked;
        let note: string | undefined;
        let execution: Execution | undefined;
        if (args.command) {
          ({ t, note } = await forCommand(ctx, args.terminal));
          execution = await startCommand(ctx, t, args.command);
        } else {
          t = args.terminal ? await existing(ctx, args.terminal) : (manager.currentFor(ctx.session) ?? (await forCommand(ctx, undefined)).t);
          if (t.handoff) throw busyError(t, ctx.session);
          execution = t.current;
        }
        const { outcome, since, waitedMs } = await manager.handOff(ctx.session, t, {
          message: args.message,
          execution,
          timeoutMs: (args.timeout_seconds ?? 600) * 1000,
          signal: ctx.signal,
        });
        if (outcome.kind === 'cancelled') throw new ToolError('cancelled', 'Cancelled; the request to the user was withdrawn.');
        await sleep(150);
        await t.mirror.flush();
        const { lines, startLost } = manager.linesSince(t, since);
        const block = formatClip(clipLines(lines, { maxChars: args.max_chars }), from => readCall(t, from), { startLost });
        manager.markRead(ctx.session, t, execution?.ended ? execution : undefined);
        return withNotes(t, [
          note,
          describeOutcome(outcome, t, execution, waitedMs),
          `Output in ${t.id} since the request (only what the terminal displayed; input at hidden prompts is never visible to you):`,
          block,
          statusOf(t),
        ], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_create',
      title: 'Open a terminal',
      description:
        'Opens another terminal for your session, which becomes your current one, e.g. for a dev server, another directory or environment. Pagers are off (PAGER=cat).',
      input: {
        name: z.string().max(40).optional().describe('e.g. "dev server".'),
        cwd: z.string().optional().describe('Absolute path; default your working directory.'),
        env: z.record(z.string(), z.string()).optional(),
        shell: z.string().optional().describe('e.g. "bash", "pwsh"; default the user\'s profile. Exit codes need bash, zsh, fish or PowerShell.'),
        shell_args: z.array(z.string()).optional(),
      },
      handler: async (args, ctx) => {
        await manager.ready;
        const t = await manager.create(ctx.session, { name: args.name, cwd: args.cwd, env: args.env, shell: args.shell, shellArgs: args.shell_args });
        const active = await manager.waitForShellIntegration(t, ctx.signal);
        t.starting = false;
        manager.changed();
        const shell = t.terminal.state.shell;
        return withNotes(t, [
          `Opened ${t.id} "${t.name}"${shell ? ` (${shell})` : ''}${t.cwd ? ` in ${t.cwd}` : ''}. It is now your current terminal${active ? '; shell integration is active, so commands report output and exit codes' : ''}.`,
        ], ctx.session);
      },
    }),

    defineTool({
      name: 'terminal_list',
      title: 'List terminals',
      description:
        'Lists this window\'s terminals with owner, state, running command and last exit code.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async (_args, ctx) => {
        await manager.ready;
        const current = manager.currentFor(ctx.session);
        const rows = manager.all().map(t => {
          const mine = t.origin === 'agent' && t.ownerKey === ctx.session.id;
          const alive = manager.ownerAlive(t);
          const decision = manager.access(ctx.session, t);
          const visible = decision.kind === 'allowed';
          const owner = mine
            ? 'you'
            : t.origin === 'user'
              ? 'user'
              : alive
                ? services.sessions.get(t.ownerKey!)!.label
                : 'an ended agent session';
          return {
            id: t.id,
            name: t.name,
            owner,
            ...(t === current ? { current: true } : {}),
            state: t.state,
            ...(visible && t.current ? { command: shortCommand(t.current.commandLine, 300) } : {}),
            ...(visible && t.lastExitCode !== undefined ? { lastExitCode: t.lastExitCode } : {}),
            ...(visible && t.cwd ? { cwd: t.cwd } : {}),
            access: visible ? 'yes' : decision.kind === 'ask' ? 'asks the user first' : 'refused',
            ...(t.shellIntegration ? {} : { shellIntegration: false }),
          };
        });
        if (rows.length === 0) return 'No terminals are open. terminal_run opens one for you.';
        return JSON.stringify(rows, null, 1);
      },
    }),

    defineTool({
      name: 'terminal_close',
      title: 'Close a terminal',
      description: 'Closes one of your terminals and stops what runs in it. Leave open the ones the user may still use, such as a running dev server.',
      input: { terminal: z.string() },
      annotations: { destructiveHint: true },
      handler: async (args, ctx) => {
        await manager.ready;
        const t = byId(args.terminal);
        if (t.origin === 'user') throw new ToolError('access_denied', `${t.id} is the user's own terminal; only the user closes it.`);
        if (t.ownerKey !== ctx.session.id && manager.ownerAlive(t)) {
          throw new ToolError('access_denied', `${t.id} belongs to ${services.sessions.get(t.ownerKey!)?.label ?? 'another session'}; only that session or the user can close it.`);
        }
        const running = t.current;
        t.terminal.dispose();
        return `Closed ${t.id} "${t.name}".${running ? ` It was running \`${shortCommand(running.commandLine)}\`, which was stopped.` : ''}`;
      },
    }),
  ];
}

function describeOutcome(outcome: HandoffOutcome, t: Tracked, execution: Execution | undefined, waitedMs: number): string {
  const after = formatDuration(waitedMs);
  const running = execution && !execution.ended ? ` \`${shortCommand(execution.commandLine)}\` is still running.` : '';
  switch (outcome.kind) {
    case 'command-finished': {
      const code = execution?.exitCode !== undefined ? `exited with code ${execution.exitCode}` : 'finished';
      return `\`${shortCommand(execution!.commandLine)}\` ${code} after ${after}, with the user at the terminal.`;
    }
    case 'done':
      return `The user said they are done (after ${after}).${running}`;
    case 'declined':
      return `The user declined ("Won't Do") after ${after}. Do not ask again; continue without it, or ask the user in chat what they would prefer.${running}`;
    case 'dismissed':
      return `The user closed the request without answering (after ${after}). Check the output below; if it is unclear whether they finished, ask them in chat.${running}`;
    case 'timeout':
      return `No answer from the user within ${after}; the request was withdrawn.${running} Ask the user in chat before trying again.`;
    case 'closed':
      return `The terminal ${t.id} was closed (after ${after}).`;
    case 'cancelled':
      return 'Cancelled.';
  }
}

function toPattern(text: string): RegExp {
  try {
    return new RegExp(text, 'i');
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}
