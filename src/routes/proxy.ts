import { Router } from 'express';
import { sessionManager } from '../services/sessionService';
import { getProxiedHtml } from '../services/proxyService';

const router = Router();

const resolveTargetUrl = (rawHref: string | undefined, currentUrl: string): string | null => {
  if (!rawHref) return null;
  const href = rawHref.trim();
  if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return null;
  }
  try {
    return new URL(href, currentUrl).toString();
  } catch {
    return null;
  }
};

const clickWithFallbacks = async (page: any, selector: string) => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'attached', timeout: 8000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: 8000 });
  } catch {
    await locator.click({ timeout: 8000, force: true }).catch(async () => {
      await locator.evaluate((el: HTMLElement) => el.click());
    });
  }
};

// POST /api/proxy/session — open browser, load URL, return HTML snapshot
router.post('/session', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    const sessionId = await sessionManager.createSession(url);
    const session   = sessionManager.getSession(sessionId);
    if (!session) throw new Error('Session creation failed');

    const html = await getProxiedHtml(session.page, url);
    return res.json({ sessionId, html });
  } catch (err: any) {
    console.error('[session]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/interact — perform an action in the live Playwright session
router.post('/interact', async (req, res) => {
  const { sessionId, action, selector, value, href } = req.body;

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }

  const page = session.page;

  try {
    // ── Fill: sync value to Playwright, no HTML refresh ─────────────────
    if (action === 'fill') {
      console.log(`[fill] "${selector}" = "${value}"`);
      await page.locator(selector).first().fill(value ?? '', { timeout: 5000 });
      return res.json({ ok: true });
    }

    // ── Navigate via URL (preferred for links) ───────────────────────────
    if (action === 'navigate' || action === 'click') {
      const target = resolveTargetUrl(href, page.url());

      if (target) {
        console.log(`[navigate] → ${target}`);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else {
        // Relative href or no href — fall back to element click
        console.log(`[click] "${selector}"`);
        await clickWithFallbacks(page, selector);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      }
      await page.waitForTimeout(600); // buffer for SPA hydration
    }

  } catch (err: any) {
    console.error(`[interact] ${action} on "${selector}" failed:`, err.message);
    // Fall through — return current page state so UI doesn't break
  }

  try {
    const html = await getProxiedHtml(page, page.url());
    return res.json({ html, url: page.url() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/execute-js — run JavaScript in the live Playwright session
router.post('/execute-js', async (req, res) => {
  const { sessionId, code } = req.body;

  if (!sessionId || !code) {
    return res.status(400).json({ error: 'sessionId and code are required.' });
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }

  try {
    // Wrap in an async IIFE so "return" works at top level in user code
    const wrappedCode = `(async () => { ${code} })()`;
    const result = await session.page.evaluate(wrappedCode);
    return res.json({ result: result !== undefined ? result : null, ok: true });
  } catch (err: any) {
    console.error('[execute-js] error:', err.message);
    return res.status(200).json({ error: err.message, ok: false });
  }
});

export default router;

