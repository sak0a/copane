// The one place where the extension asks the user a question (consent for a tab, a hand-off in a
// terminal ...). Modules call `services.prompts.ask` instead of `vscode.window.show*Message`, so
// prompts look alike and can be answered automatically in development and tests.
import * as vscode from 'vscode';
import type { Logger } from './log';
import { StatusBarQuestions } from './promptStatus';

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
  /**
   * Where the question appears. "notification" (default): a notification. "statusBar": a status bar
   * item the user clicks to answer the question in a modal dialog (promptStatus.ts). Use it for
   * questions about a browser tab: VS Code pauses a browser view while a notification covers it, and a
   * status bar item covers nothing. `autoClose` is implied (the item goes away when `signal` aborts).
   */
  placement?: 'notification' | 'statusBar';
  /** Short text for the status bar item, e.g. "Claude 2 asks to use tab-3" (default: the message, shortened). */
  summary?: string;
}

/** A text field the user types into, e.g. a user name, or a password with `password: true`. */
export interface InputPrompt {
  /** Title of the input box, naming who asks and for what, e.g. 'Login for intranet.corp (realm "Staff")'. */
  title: string;
  /** What to type, shown below the field, e.g. "User name". */
  prompt: string;
  /** Pre-filled text. */
  value?: string;
  placeholder?: string;
  /** Mask what is typed. The answer is never written to logs or the prompt history. */
  password?: boolean;
  /** Resolves undefined when aborted, and closes the input box. */
  signal?: AbortSignal;
}

export interface PromptService {
  ask(prompt: UserPrompt): Promise<string | undefined>;
  /**
   * Asks the user to type something. Resolves undefined when they cancel. It takes keyboard focus, so
   * only call it right after the user chose to answer (e.g. a button in an `ask` prompt), never out of
   * the blue: keys meant for the editor would land in it. Optional so other implementations stay valid.
   */
  input?(prompt: InputPrompt): Promise<string | undefined>;
}

const ANSWER_COMMAND = 'copane.answerPrompt';

export class VscodePrompts implements PromptService {
  /** Answers queued by the `debug_answer_prompts` tool (development only), used before asking the user. */
  readonly queuedAnswers: Array<string | null> = [];
  /** Prompts shown so far, newest last, for tests to inspect. Input prompts have `input` set; a password answer is recorded as "(hidden)". */
  readonly history: Array<{ message: string; choices: string[]; answer: string | undefined; input?: { prompt: string; value?: string; password: boolean }; placement?: 'notification' | 'statusBar' }> = [];
  /** Questions shown in the status bar (`placement: "statusBar"`). */
  readonly statusBar = new StatusBarQuestions();

  private nextId = 1;
  /** Dismissable prompts that are on screen, by id. */
  private readonly open = new Map<string, (choice: string) => void>();

  constructor(private readonly log: Logger) {}

  async ask(prompt: UserPrompt): Promise<string | undefined> {
    const answer = await this.resolve(prompt);
    this.history.push({ message: prompt.message, choices: prompt.choices, answer, placement: prompt.placement ?? 'notification' });
    if (this.history.length > 50) this.history.shift();
    return answer;
  }

  async input(prompt: InputPrompt): Promise<string | undefined> {
    const answer = await this.resolveInput(prompt);
    const recorded = prompt.password && answer !== undefined ? '(hidden)' : answer;
    this.history.push({ message: prompt.title, choices: [], answer: recorded, input: { prompt: prompt.prompt, value: prompt.value, password: Boolean(prompt.password) } });
    if (this.history.length > 50) this.history.shift();
    return answer;
  }

  private async resolveInput(prompt: InputPrompt): Promise<string | undefined> {
    if (this.queuedAnswers.length > 0) {
      const queued = this.queuedAnswers.shift() ?? undefined;
      this.log.info(`input "${prompt.title}: ${prompt.prompt}" answered automatically${prompt.password ? '' : `: ${queued ?? '(dismissed)'}`}`);
      return queued;
    }
    const signal = prompt.signal;
    if (signal?.aborted) return undefined;
    const cancel = new vscode.CancellationTokenSource();
    const onAbort = () => cancel.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const answer = await vscode.window.showInputBox(
        { title: prompt.title, prompt: prompt.prompt, value: prompt.value, placeHolder: prompt.placeholder, password: prompt.password ?? false, ignoreFocusOut: true },
        cancel.token,
      );
      return signal?.aborted ? undefined : answer;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cancel.dispose();
    }
  }

  private async resolve(prompt: UserPrompt): Promise<string | undefined> {
    if (this.queuedAnswers.length > 0) {
      const queued = this.queuedAnswers.shift() ?? undefined;
      this.log.info(`prompt "${prompt.message}" answered automatically: ${queued ?? '(dismissed)'}`);
      return queued !== undefined && prompt.choices.includes(queued) ? queued : undefined;
    }
    if (prompt.signal?.aborted) return undefined;
    if (prompt.placement === 'statusBar' && !prompt.modal) return this.statusBar.ask(prompt);
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

  /** Registers the command behind the choice links, and the status bar questions. */
  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.commands.registerCommand(ANSWER_COMMAND, (id: string, choice: string) => this.open.get(id)?.(choice)),
      this.statusBar.register(),
    );
  }
}
