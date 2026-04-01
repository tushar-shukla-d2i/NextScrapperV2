import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { randomUUID } from 'node:crypto';

interface ScraperSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastActive: number;
}

class SessionManager {
  private sessions: Map<string, ScraperSession> = new Map();
  private readonly TIMEOUT = 10 * 60 * 1000; // 10 minutes

  constructor() {
    // Cleanup inactive sessions every minute
    setInterval(() => this.cleanup(), 60000);
  }

  async createSession(url: string): Promise<string> {
    const id = randomUUID();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    this.sessions.set(id, {
      id,
      browser,
      context,
      page,
      lastActive: Date.now(),
    });

    return id;
  }

  getSession(id: string): ScraperSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActive = Date.now();
    }
    return session;
  }

  async closeSession(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      await session.browser.close();
      this.sessions.delete(id);
    }
  }

  private async cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.TIMEOUT) {
        console.log(`Cleaning up inactive session: ${id}`);
        await this.closeSession(id);
      }
    }
  }
}

export const sessionManager = new SessionManager();
