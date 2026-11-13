// The one place where the extension asks the user a question (consent for a tab, a hand-off in a
// terminal ...). Modules call `services.prompts.ask` instead of `vscode.window.show*Message`, so
// prompts look alike and can be answered automatically in development and tests.
import * as vscode from 'vscode';
import type { Logger } from './log';

export interface UserPrompt {
  /** One sentence, naming the session, e.g. 'Claude 2 wants to use the tab "localhost:3000".' */
  message: string;
  /** Extra explanation, shown below the message in a modal prompt. */
  detail?: string;
  /** Button labels, most likely first. The result is one of these, or undefined when dismissed. */
  choices: string[];
  /** Blocks the window until answered. Use only when the agent is waiting on the answer. */
  modal?: boolean;
  /** Resolves undefined when aborted. The notification stays on screen unless `autoClose` is set. */
  signal?: AbortSignal;
  /**
   * Remove the notification from the screen when `signal` aborts, for questions that stop making
   * sense by themselves (a hand-off whose command has finished). VS Code can only close progress
   * notifications from code, so such a prompt shows its choices as links instead of buttons; keep
   * the default for anything where clear buttons matter more (consent).
   */
  autoClose?: boolean;
}

export interface PromptService {
  ask(prompt: UserPrompt): Promise<string | undefined>;
}

const ANSWER_COMMAND = 'agentBridge.answerPrompt';

export class VscodePrompts implements PromptService {
  /** Answers queued by the `debug_answer_prompts` tool (development only), used before asking the user. */
  readonly queuedAnswers: Array<string | null> = [];
  /** Prompts shown so far, newest last, for tests to inspect. */
  readonly history: Array<{ message: string; choices: string[]; answer: string | undefined }> = [];

  private nextId = 1;
  /** Dismissable prompts that are on screen, by id. */
  private readonly open = new Map<string, (choice: string) => void>();

  constructor(private readonly log: Logger) {}

  async ask(prompt: UserPrompt): Promise<string | undefined> {
    const answer = await this.resolve(prompt);
    this.history.push({ message: prompt.message, choices: prompt.choices, answer });
    if (this.history.length > 50) this.history.shift();
    return answer;
  }

  private async resolve(prompt: UserPrompt): Promise<string | undefined> {
    if (this.queuedAnswers.length > 0) {
      const queued = this.queuedAnswers.shift() ?? undefined;
      this.log.info(`prompt "${prompt.message}" answered automatically: ${queued ?? '(dismissed)'}`);
      return queued !== undefined && prompt.choices.includes(queued) ? queued : undefined;
    }
    if (prompt.signal?.aborted) return undefined;
    if (prompt.autoClose && prompt.signal && !prompt.modal) return this.askDismissable(prompt, prompt.signal);
    const shown = vscode.window.showInformationMessage(prompt.message, { modal: prompt.modal ?? false, detail: prompt.modal ? prompt.detail : undefined }, ...prompt.choices);
    const signal = prompt.signal;
    if (!signal) return shown;
    return new Promise<string | undefined>(resolve => {
      const onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      void shown.then(
        value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        () => resolve(undefined),
      );
    });
  }

  /**
   * A notification that goes away by itself when the question is no longer open (`signal` aborted).
   * VS Code cannot close a message notification from code, only a progress notification, so this is
   * one: the choices are links in its text, and its close button counts as dismissing the question.
   */
  private askDismissable(prompt: UserPrompt, signal: AbortSignal): Promise<string | undefined> {
    const id = String(this.nextId++);
    return new Promise<string | undefined>(resolve => {
      let settled = false;
      let closeNotification = () => {};
      const settle = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        this.open.delete(id);
        signal.removeEventListener('abort', onAbort);
        closeNotification();
        resolve(value);
      };
      const onAbort = () => settle(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      this.open.set(id, choice => settle(prompt.choices.includes(choice) ? choice : undefined));
      const links = prompt.choices
        .map(choice => `[${choice}](command:${ANSWER_COMMAND}?${encodeURIComponent(JSON.stringify([id, choice]))})`)
        .join('\u2002·\u2002');
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${prompt.message}\u2002${links}`, cancellable: true }, (_progress, token) => {
        token.onCancellationRequested(() => settle(undefined));
        return new Promise<void>(done => {
          closeNotification = done;
          if (settled) done();
        });
      });
    });
  }

  /** Registers the command behind the choice links. */
  register(): vscode.Disposable {
    return vscode.commands.registerCommand(ANSWER_COMMAND, (id: string, choice: string) => this.open.get(id)?.(choice));
  }
}
