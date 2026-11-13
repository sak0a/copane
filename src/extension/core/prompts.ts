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
  /** Resolves undefined when aborted (the notification itself may stay until the user closes it). */
  signal?: AbortSignal;
}

export interface PromptService {
  ask(prompt: UserPrompt): Promise<string | undefined>;
}

export class VscodePrompts implements PromptService {
  /** Answers queued by the `debug_answer_prompts` tool (development only), used before asking the user. */
  readonly queuedAnswers: Array<string | null> = [];
  /** Prompts shown so far, newest last, for tests to inspect. */
  readonly history: Array<{ message: string; choices: string[]; answer: string | undefined }> = [];

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
    const shown = vscode.window.showInformationMessage(prompt.message, { modal: prompt.modal ?? false, detail: prompt.modal ? prompt.detail : undefined }, ...prompt.choices);
    if (!prompt.signal) return shown;
    return new Promise<string | undefined>(resolve => {
      const onAbort = () => resolve(undefined);
      prompt.signal!.addEventListener('abort', onAbort, { once: true });
      void shown.then(
        value => {
          prompt.signal!.removeEventListener('abort', onAbort);
          resolve(value);
        },
        () => resolve(undefined),
      );
    });
  }
}
