// Questions shown in the status bar instead of a notification (`UserPrompt.placement: "statusBar"`).
//
// Why: VS Code pauses a browser view while a notification toast or the notification centre overlaps
// it (the view is hidden and a dimmed screenshot with "Paused due to Notification" is shown instead;
// see docs/ARCHITECTURE.md, "Prompts and the browser"). A question about a tab would pause exactly the
// tab it is about, and any other visible tab under the toast: the user cannot look at the page while
// deciding, screenshots of a paused view take seconds, and a tab opened meanwhile keeps a 1024×768
// placeholder size. A status bar item covers nothing.
//
// How the user answers: the item (warning colours, "Claude 2 asks to use tab-3") opens the oldest
// waiting question in a modal dialog with the same buttons, so the decision stays a deliberate click
// in VS Code's own UI. Nothing a web page does can open or answer it: the command takes no arguments
// and only shows the dialog; the dialog's buttons are VS Code's. Closing the dialog without a choice
// counts as dismissing the question, like closing a notification.
import * as vscode from 'vscode';
import type { UserPrompt } from './prompts';

export const ANSWER_QUESTION_COMMAND = 'copane.answerQuestion';
const CONTEXT_KEY = 'copane.questionsWaiting';

interface Waiting {
  prompt: UserPrompt;
  since: number;
  settle(answer: string | undefined): void;
}

export class StatusBarQuestions implements vscode.Disposable {
  private readonly waiting: Waiting[] = [];
  private item: vscode.StatusBarItem | undefined;
  /** A dialog is open (VS Code shows one modal at a time; it cannot be closed from code). */
  private showing: Waiting | undefined;

  ask(prompt: UserPrompt): Promise<string | undefined> {
    const signal = prompt.signal;
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const entry: Waiting = {
        prompt,
        since: Date.now(),
        settle: answer => {
          const i = this.waiting.indexOf(entry);
          if (i < 0) return;
          this.waiting.splice(i, 1);
          signal?.removeEventListener('abort', onAbort);
          this.update();
          resolve(answer);
        },
      };
      const onAbort = () => entry.settle(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      this.update();
    });
  }

  /** Questions waiting, oldest first (for tests and the UI). */
  list(): Array<{ message: string; summary: string; since: number }> {
    return this.waiting.map(w => ({ message: w.prompt.message, summary: summaryOf(w.prompt), since: w.since }));
  }

  /** Shows the oldest waiting question in a modal dialog. The command behind the status bar item. */
  async answerNext(): Promise<void> {
    if (this.showing) return;
    const entry = this.waiting[0];
    if (!entry) {
      vscode.window.setStatusBarMessage('No agent is waiting for an answer.', 4000);
      return;
    }
    this.showing = entry;
    this.update();
    try {
      const { prompt } = entry;
      const answer = await vscode.window.showInformationMessage(prompt.message, { modal: true, detail: prompt.detail }, ...prompt.choices);
      entry.settle(answer !== undefined && prompt.choices.includes(answer) ? answer : undefined);
    } finally {
      this.showing = undefined;
      this.update();
    }
  }

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.commands.registerCommand(ANSWER_QUESTION_COMMAND, () => this.answerNext()),
      this,
    );
  }

  dispose(): void {
    for (const entry of [...this.waiting]) entry.settle(undefined);
    this.item?.dispose();
    this.item = undefined;
  }

  private update(): void {
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, this.waiting.length > 0);
    if (!this.waiting.length) {
      this.item?.hide();
      return;
    }
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem('copane.questions', vscode.StatusBarAlignment.Left, 10_000);
      this.item.name = 'Copane: questions from agents';
      this.item.command = ANSWER_QUESTION_COMMAND;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    const n = this.waiting.length;
    const first = this.waiting[0]!;
    this.item.text = n === 1 ? `$(question) ${summaryOf(first.prompt)}` : `$(question) ${n} agent questions`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    tooltip.appendText(n === 1 ? 'An agent is waiting for your answer:' : `${n} questions are waiting for your answer, oldest first:`);
    for (const w of this.waiting) tooltip.appendMarkdown('\n\n- ').appendText(w.prompt.message);
    tooltip.appendMarkdown('\n\n').appendText(this.showing ? 'The question is open in a dialog.' : 'Click to answer.');
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = { label: `${n === 1 ? first.prompt.message : `${n} agent questions waiting`}. Activate to answer.`, role: 'button' };
    this.item.show();
  }
}

function summaryOf(prompt: UserPrompt): string {
  const text = prompt.summary ?? prompt.message;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
