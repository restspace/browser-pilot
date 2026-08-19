import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Video } from 'playwright-core';
import { ensureSessionDir } from '../shared/paths.js';
import { DialogManager } from './dialogs.js';
import { ScriptRecorder } from './recorder.js';

const VIEWPORT = { width: 1280, height: 900 };

export interface BrowserOptions {
  session: string;
  headed?: boolean;
  /** Playwright channel; defaults to installed Chrome, then Edge. */
  channel?: string;
  executablePath?: string;
  /** Persist cookies/localStorage in the session profile dir (default true). */
  persist?: boolean;
  /**
   * Record the whole session to webm, one file per tab. Playwright only offers
   * video as a context-creation option and only finalises the files on context
   * close, so this is fixed when the browser launches and the paths come back
   * from close() — there is no mid-session start/stop.
   */
  record?: boolean;
  /**
   * Record every action as a replayable Playwright step (see ScriptRecorder).
   * Unlike video this costs a page round trip per action (resolving a durable
   * selector), so it is opt-in and fixed for the life of the session.
   */
  script?: boolean;
}

/**
 * Owns the Playwright context for one session: a persistent profile so
 * logins survive daemon restarts, plus dialog capture wired to every page.
 */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  /** Videos of every page adopted this session, kept so close() can resolve their paths. */
  private videos = new Set<Video>();
  readonly dialogs = new DialogManager();
  /** Non-null only when script recording is on; tools feed it every action. */
  readonly script: ScriptRecorder | null;

  constructor(private opts: BrowserOptions) {
    this.script =
      opts.script || process.env.BROWSER_PILOT_SCRIPT === '1' ? new ScriptRecorder(opts.session) : null;
  }

  private async launch(): Promise<BrowserContext> {
    const headless = !(this.opts.headed || process.env.BROWSER_PILOT_HEADED === '1');
    const executablePath = this.opts.executablePath || process.env.BROWSER_PILOT_EXECUTABLE || undefined;
    const recordVideo = this.recording
      ? { dir: path.join(ensureSessionDir(this.opts.session), 'video'), size: VIEWPORT }
      : undefined;
    const channels = executablePath
      ? [undefined]
      : [this.opts.channel || process.env.BROWSER_PILOT_CHANNEL || 'chrome', 'msedge', 'chromium'];

    let lastErr: unknown;
    for (const channel of channels) {
      try {
        if (this.opts.persist === false) {
          const browser = await chromium.launch({ headless, channel: channel as string | undefined, executablePath });
          return await browser.newContext({ viewport: VIEWPORT, recordVideo });
        }
        const userDataDir = path.join(ensureSessionDir(this.opts.session), 'profile');
        return await chromium.launchPersistentContext(userDataDir, {
          headless,
          channel: channel as string | undefined,
          executablePath,
          viewport: VIEWPORT,
          recordVideo,
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
    const video = page.video();
    if (video) this.videos.add(video);
    this.activePage = page;
    page.on('close', () => {
      if (this.activePage === page) this.activePage = null;
    });
  }

  /** Whether a context is already live — so callers can look without launching one. */
  get isOpen(): boolean {
    return this.context !== null;
  }

  /** Whether this session records video (flag or env; fixed at construction). */
  get recording(): boolean {
    return Boolean(this.opts.record || process.env.BROWSER_PILOT_RECORD === '1');
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

  /**
   * Close the context and return the recorded video paths (empty unless
   * recording). Videos are only written out on context close, so this is the
   * one moment they can be reported. Idempotent.
   */
  async close(): Promise<string[]> {
    const context = this.context;
    if (context) {
      this.context = null;
      this.activePage = null;
      const browser = context.browser();
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
    const videos = [...this.videos];
    this.videos.clear();
    const paths = await Promise.all(videos.map((v) => v.path().catch(() => null)));
    return paths.filter((p): p is string => Boolean(p));
  }
}
