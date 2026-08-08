import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { ensureSessionDir } from '../shared/paths.js';
import { DialogManager } from './dialogs.js';

export interface BrowserOptions {
  session: string;
  headed?: boolean;
  /** Playwright channel; defaults to installed Chrome, then Edge. */
  channel?: string;
  executablePath?: string;
  /** Persist cookies/localStorage in the session profile dir (default true). */
  persist?: boolean;
}

/**
 * Owns the Playwright context for one session: a persistent profile so
 * logins survive daemon restarts, plus dialog capture wired to every page.
 */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  readonly dialogs = new DialogManager();

  constructor(private opts: BrowserOptions) {}

  private async launch(): Promise<BrowserContext> {
    const headless = !(this.opts.headed || process.env.BROWSER_PILOT_HEADED === '1');
    const executablePath = this.opts.executablePath || process.env.BROWSER_PILOT_EXECUTABLE || undefined;
    const channels = executablePath
      ? [undefined]
      : [this.opts.channel || process.env.BROWSER_PILOT_CHANNEL || 'chrome', 'msedge', 'chromium'];

    let lastErr: unknown;
    for (const channel of channels) {
      try {
        if (this.opts.persist === false) {
          const browser = await chromium.launch({ headless, channel: channel as string | undefined, executablePath });
          return await browser.newContext();
        }
        const userDataDir = path.join(ensureSessionDir(this.opts.session), 'profile');
        return await chromium.launchPersistentContext(userDataDir, {
          headless,
          channel: channel as string | undefined,
          executablePath,
          viewport: { width: 1280, height: 900 },
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `could not launch a browser (tried channels: chrome, msedge, chromium). ` +
        `Install Chrome/Edge or set BROWSER_PILOT_EXECUTABLE. Last error: ${(lastErr as Error)?.message}`,
    );
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.context) {
      this.context = await this.launch();
      this.context.on('page', (p) => this.adoptPage(p));
      this.context.on('close', () => {
        this.context = null;
        this.activePage = null;
      });
      for (const p of this.context.pages()) this.adoptPage(p);
    }
    return this.context;
  }

  private adoptPage(page: Page): void {
    this.dialogs.attach(page);
    this.activePage = page;
    page.on('close', () => {
      if (this.activePage === page) this.activePage = null;
    });
  }

  /** Current page, creating one if none is open. */
  async getPage(): Promise<Page> {
    const context = await this.getContext();
    if (this.activePage && !this.activePage.isClosed()) return this.activePage;
    const existing = context.pages().find((p) => !p.isClosed());
    if (existing) {
      this.activePage = existing;
      return existing;
    }
    const page = await context.newPage();
    this.activePage = page;
    return page;
  }

  /** Pages in the context, for tab-switching tools. */
  async listPages(): Promise<Page[]> {
    const context = await this.getContext();
    return context.pages().filter((p) => !p.isClosed());
  }

  async switchToPage(index: number): Promise<Page> {
    const pages = await this.listPages();
    const page = pages[index];
    if (!page) throw new Error(`no tab at index ${index} (open tabs: ${pages.length})`);
    this.activePage = page;
    await page.bringToFront().catch(() => {});
    return page;
  }

  async close(): Promise<void> {
    const context = this.context;
    if (context) {
      this.context = null;
      this.activePage = null;
      const browser = context.browser();
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
}
