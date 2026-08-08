import type { Dialog, Page } from 'playwright-core';

export interface DialogPolicy {
  action: 'accept' | 'dismiss';
  /** Text to enter when the dialog is a prompt(). */
  promptText?: string;
  /** How many dialogs this policy covers before reverting to the default. */
  remaining: number;
}

export interface CapturedDialog {
  type: string;
  message: string;
  action: 'accept' | 'dismiss';
  promptText?: string;
}

/**
 * Native dialog handling (friction #4). Every page gets a handler installed;
 * by default dialogs are dismissed and captured so the agent sees them.
 * `dialog_expect` arms a one-shot (or N-shot) accept/dismiss policy for the
 * next action. Captured messages are drained into tool results.
 */
export class DialogManager {
  private policy: DialogPolicy | null = null;
  private captured: CapturedDialog[] = [];
  private attached = new WeakSet<Page>();

  attach(page: Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    page.on('dialog', (dialog) => void this.handle(dialog));
  }

  arm(policy: Omit<DialogPolicy, 'remaining'> & { remaining?: number }): void {
    this.policy = { remaining: 1, ...policy };
  }

  private async handle(dialog: Dialog): Promise<void> {
    let action: 'accept' | 'dismiss' = 'dismiss';
    let promptText: string | undefined;
    if (this.policy && this.policy.remaining > 0) {
      action = this.policy.action;
      promptText = this.policy.promptText;
      this.policy.remaining -= 1;
      if (this.policy.remaining <= 0) this.policy = null;
    } else if (dialog.type() === 'beforeunload') {
      action = 'accept'; // otherwise navigation deadlocks
    }
    this.captured.push({ type: dialog.type(), message: dialog.message(), action, promptText });
    try {
      if (action === 'accept') await dialog.accept(promptText);
      else await dialog.dismiss();
    } catch {
      // dialog may already be handled/closed
    }
  }

  /** Return captured dialogs since last drain and clear the buffer. */
  drain(): CapturedDialog[] {
    const out = this.captured;
    this.captured = [];
    return out;
  }

  peek(): CapturedDialog[] {
    return [...this.captured];
  }

  armedPolicy(): DialogPolicy | null {
    return this.policy;
  }
}
