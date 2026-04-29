import { chromium } from 'playwright';
const SCRAPER_BUILD = '2026-04-28T13:35-fallback-v3';

// ── Types (must match workflowStore.ts on the client) ─────────────────────────
export interface ExtractionField {
  id: string;
  label: string;
  selector: string;
  attribute: 'textContent' | 'value' | 'href' | 'src' | 'innerHTML';
}

export interface Step {
  id?: string;
  action: 'click' | 'extract' | 'navigate' | 'fill' | 'iterate' | 'javascript' | 'wait';
  selector?: string;
  value?: string;
  text?: string;
  label?: string;
  attribute?: 'textContent' | 'value' | 'href' | 'src' | 'innerHTML';
  // iterate
  itemSelector?: string;
  iterateSteps?: Step[];
  // javascript
  jsCode?: string;
  // wait
  waitMs?: number;
}

export interface WorkflowConfig {
  url: string;
  steps: Step[];
  extractionTemplate: ExtractionField[];
}

// ── Attribute extractor helper ────────────────────────────────────────────────
async function extractValue(
  page: any,
  selector: string,
  attribute: string,
  contextHandle?: any,
  textHint?: string,
  preferPageContext: boolean = false
): Promise<string> {
  try {
    const ctx = preferPageContext ? page : (contextHandle || page);
    let el = null as any;

    const hint = (textHint || '').trim().toLowerCase();

    // When selector is generic (e.g. many repeated `.value` blocks),
    // pick the candidate whose surrounding text includes the label hint.
    // Apply this primarily to text extraction to avoid breaking href/src clicks.
    if (hint && selector && attribute !== 'href' && attribute !== 'src') {
      try {
        // Cheap first try: if the value element itself includes the hint, use it.
        if (!contextHandle && hint) {
          const refined = page.locator(selector).filter({ hasText: textHint!.trim() }).first();
          if ((await refined.count()) > 0) el = await refined.elementHandle();
        }

        if (!el) {
          const maxCandidates = 30;
          const candidates = (() => {
            try {
              if (contextHandle && !preferPageContext && typeof (ctx as any).$$ === 'function') {
                return (ctx as any).$$(selector);
              }
            } catch {
              // ignore
            }
            return page.$$(selector);
          })();

          const arr = await candidates;
          for (let i = 0; i < Math.min(arr.length, maxCandidates); i++) {
            const candidate = arr[i];
            if (!candidate) continue;
            const candidateText = await candidate.evaluate((node: any) => {
              let cur = node;
              let t = '';
              // Look up a few ancestor levels for the label text.
              for (let depth = 0; depth < 3; depth++) {
                if (!cur) break;
                t += ' ' + (cur?.innerText || '');
                cur = cur.parentElement;
              }
              return (t || node?.innerText || '').replace(/\s+/g, ' ').trim();
            });
            if (candidateText && candidateText.toLowerCase().includes(hint)) {
              el = candidate;
              break;
            }
          }
        }
      } catch {
        // ignore and fall back to normal resolution
      }
    }

    if (!el) {
      el = await ctx.$(selector);
    }

    // If selector did not match in the item context (e.g. we already navigated),
    // fall back to page context to keep later "extract" steps working.
    if (!el) {
      if (contextHandle) {
        try {
          el = await page.$(selector);
        } catch {
          el = null;
        }
      }
      if (!el) return '';
    }

    // Some recorded selectors point at a button/span, while the actual link is a
    // nested <a href="...">. When callers ask for href/src, resolve it from
    // nested anchors/media first.
    if (attribute === 'href') {
      const direct = (await el.getAttribute('href').catch(() => '')) || '';
      if (direct) return direct;
      const nested = await el.$('a[href]').catch(() => null);
      if (nested) {
        const nestedHref = (await nested.getAttribute('href').catch(() => '')) || '';
        if (nestedHref) return nestedHref;
      }
      const anyHref = await el.$('*[href]').catch(() => null);
      if (anyHref) {
        const anyHrefVal = (await anyHref.getAttribute('href').catch(() => '')) || '';
        if (anyHrefVal) return anyHrefVal;
      }
      return '';
    }

    if (attribute === 'src') {
      const direct = (await el.getAttribute('src').catch(() => '')) || '';
      if (direct) return direct;
      const nested = await el.$('img[src]').catch(() => null);
      if (nested) {
        const nestedSrc = (await nested.getAttribute('src').catch(() => '')) || '';
        if (nestedSrc) return nestedSrc;
      }
      const anySrc = await el.$('*[src]').catch(() => null);
      if (anySrc) {
        const anySrcVal = (await anySrc.getAttribute('src').catch(() => '')) || '';
        if (anySrcVal) return anySrcVal;
      }
      return '';
    }

    switch (attribute) {
      case 'textContent':
        return (await el.textContent() || '').trim();
      case 'innerHTML':
        return await el.innerHTML() || '';
      case 'value':
        return await el.inputValue().catch(() => '') || '';
      case 'href':
        // handled above
        return '';
      case 'src':
        // handled above
        return '';
      default:
        return await el.getAttribute(attribute) || '';
    }
  } catch {
    return '';
  }
}

function normalizeSelectorForItemContext(selector: string): string {
  if (!selector) return selector;
  // Recorded selectors may contain fixed text (e.g. :has-text("Egg Donor (ED03168)"))
  // which limits loop extraction to one specific card. Strip text pseudo-filters
  // for item-context queries so each item can resolve its own matching element.
  return selector
    .replace(/:has-text\(\s*"[^"]*"\s*\)/gi, '')
    .replace(/:has-text\(\s*'[^']*'\s*\)/gi, '')
    .replace(/:text\(\s*"[^"]*"\s*\)/gi, '')
    .replace(/:text\(\s*'[^']*'\s*\)/gi, '')
    // Also strip fixed href/src attribute values that can lock iteration to one donor link.
    .replace(/\[\s*href\s*=\s*"[^"]*"\s*\]/gi, '[href]')
    .replace(/\[\s*href\s*=\s*'[^']*'\s*\]/gi, '[href]')
    .replace(/\[\s*src\s*=\s*"[^"]*"\s*\]/gi, '[src]')
    .replace(/\[\s*src\s*=\s*'[^']*'\s*\]/gi, '[src]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function selectorCacheKey(selector: string): string {
  // Safe, stable object key fragment for caching extracted href/src per sub-step.
  // Keep it reasonably short to avoid huge keys for complex selectors.
  const s = (selector || '').trim().replace(/\s+/g, ' ');
  return s.replace(/[^\w-]/g, '_').slice(0, 120);
}

// ── Apply extraction template to a page/element context ──────────────────────
async function applyTemplate(
  page: any,
  template: ExtractionField[],
  contextHandle?: any
): Promise<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const field of template) {
    if (!field.label || !field.selector) continue;
    // Use the field label as a hint to disambiguate selectors that match
    // multiple "value" blocks (common in card UIs).
    record[field.label] = await extractValue(
      page,
      field.selector,
      field.attribute,
      contextHandle,
      field.label,
      false
    );
  }
  return record;
}

async function runUserJavaScript(page: any, jsCode: string, contextHandle?: any): Promise<any> {
  if (contextHandle) {
    return contextHandle.evaluate((element: any, source: string) => {
      const fn = new Function(
        'element',
        `return (async () => { ${source} })();`
      );
      return fn(element);
    }, jsCode);
  }

  return page.evaluate((source: string) => {
    const fn = new Function(`return (async () => { ${source} })();`);
    return fn();
  }, jsCode);
}

async function clickWithFallbacks(
  page: any,
  selector: string,
  textHint?: string,
  contextHandle?: any
): Promise<void> {
  const timeoutMs = 8000;

  if (contextHandle) {
    const target = await contextHandle.$(selector);
    if (target) {
      await target.click().catch(async () => {
        await target.evaluate((el: HTMLElement) => el.click());
      });
      return;
    }
  }

  let locator = page.locator(selector).first();

  // If caller captured visible text during recording, use it to disambiguate
  // broad selectors (e.g. repeated nav labels/buttons).
  if (textHint && textHint.trim()) {
    const trimmed = textHint.trim();
    const byTextWithinSelector = page.locator(selector).filter({ hasText: trimmed }).first();
    if (await byTextWithinSelector.count()) {
      locator = byTextWithinSelector;
    } else {
      const byTextAnywhere = page.getByText(trimmed, { exact: false }).first();
      if (await byTextAnywhere.count()) locator = byTextAnywhere;
    }
  }

  await locator.waitFor({ state: 'attached', timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await locator.click({ timeout: timeoutMs });
  } catch {
    // Last resort for covered/offscreen elements: dispatch DOM click directly.
    await locator.click({ timeout: timeoutMs, force: true }).catch(async () => {
      await locator.evaluate((el: HTMLElement) => el.click());
    });
  }
}

function resolveNavigationTarget(rawTarget: string | undefined, currentUrl: string): string | null {
  if (!rawTarget) return null;
  const target = rawTarget.trim();
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) return target;
  if (target.startsWith('/')) {
    try {
      return new URL(target, currentUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function inferValueByLabel(
  page: any,
  label: string
): Promise<string> {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return '';

  try {
    const byLabel = page.getByText(label, { exact: false }).first();
    if (await byLabel.count()) {
      const text = (await byLabel.textContent() || '').trim();
      if (text && text.toLowerCase() !== normalized) return text;
    }
  } catch {
    // ignore
  }

  try {
    const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    if (!bodyText) return '';

    if (normalized === 'id') {
      const donorMatch = bodyText.match(/\bED\d{3,}\b/i);
      if (donorMatch?.[0]) return donorMatch[0];
      const numericId = bodyText.match(/\bID[:\s#-]*([A-Z0-9-]{3,})\b/i);
      if (numericId?.[1]) return numericId[1];
      const urlId = page.url().match(/\/donor\/(\d+)/i);
      if (urlId?.[1]) return urlId[1];
    }

    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nearLabel = bodyText.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*([^|\\n]{1,80})`, 'i'));
    if (nearLabel?.[1]) {
      const cleaned = nearLabel[1].trim();
      if (cleaned && cleaned.toLowerCase() !== normalized) return cleaned;
    }
  } catch {
    // ignore
  }

  return '';
}

function shouldRejectExtractedValue(label: string | undefined, value: string): boolean {
  const normalizedLabel = (label || '').trim().toLowerCase();
  const normalizedValue = (value || '').trim().toLowerCase();
  if (!normalizedLabel || !normalizedValue) return false;

  if (normalizedLabel === 'id') {
    if (
      normalizedValue === 'log out' ||
      normalizedValue === 'logout' ||
      normalizedValue === 'my dashboard' ||
      normalizedValue === 'my tasks' ||
      normalizedValue === 'egg donors'
    ) return true;

    const looksLikeDonorId = /\bed\d{3,}\b/i.test(value) || /\b\d{4,}\b/.test(value);
    if (!looksLikeDonorId && /^[a-z\s]+$/i.test(value) && value.length < 40) return true;
  }

  return false;
}

function donorTokenFromText(input?: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  const ed = raw.match(/\bED\d{3,}\b/i);
  if (ed?.[0]) return ed[0].toUpperCase();
  const donorId = raw.match(/\/donor\/(\d+)/i);
  if (donorId?.[1]) return donorId[1];
  return '';
}

async function inferFromSelectorCandidates(
  page: any,
  selector: string,
  attribute: string,
  label?: string
): Promise<string> {
  const normalizedLabel = (label || '').trim().toLowerCase();
  if (!normalizedLabel) return '';

  try {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (!count) return '';

    // For donor "id", prefer anchors/text that contain ED codes.
    if (normalizedLabel === 'id') {
      for (let i = 0; i < Math.min(count, 60); i++) {
        const item = locator.nth(i);
        const txt = ((await item.textContent()) || '').trim();
        const href = ((await item.getAttribute('href')) || '').trim();

        const ed = txt.match(/\bED\d{3,}\b/i);
        if (ed?.[0]) return ed[0];

        if (/\/donor\/\d+/i.test(href)) {
          const fromText = txt.match(/\bED\d{3,}\b/i)?.[0];
          if (fromText) return fromText;
          const donorId = href.match(/\/donor\/(\d+)/i)?.[1];
          if (donorId) return donorId;
        }
      }
    }

    // Generic fallback: first non-empty candidate matching attribute intent.
    for (let i = 0; i < Math.min(count, 30); i++) {
      const item = locator.nth(i);
      let candidate = '';
      if (attribute === 'href') candidate = ((await item.getAttribute('href')) || '').trim();
      else if (attribute === 'src') candidate = ((await item.getAttribute('src')) || '').trim();
      else candidate = ((await item.textContent()) || '').trim();
      if (candidate) return candidate;
    }
  } catch {
    // ignore
  }

  return '';
}

// ── Execute a single step on the given page ───────────────────────────────────
async function executeStep(
  page: any,
  step: Step,
  emitLog: (msg: string) => void,
  options?: {
    contextHandle?: any;
    currentRecord?: Record<string, string>;
    preferPageContext?: boolean;
  }
): Promise<void> {
  const contextHandle = options?.contextHandle;
  const currentRecord = options?.currentRecord;
  const preferPageContext = options?.preferPageContext ?? false;
  const effectiveSelector = step.selector && contextHandle
    ? normalizeSelectorForItemContext(step.selector)
    : step.selector;

  switch (step.action) {

    case 'navigate':
      if (step.value) {
        emitLog(`Navigating to ${step.value}…`);
        await page.goto(step.value, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(500);
      }
      break;

    case 'click':
      if (effectiveSelector) {
        emitLog(`Clicking "${effectiveSelector}"…`);
        try {
          let navTarget: string | null = null;

          // In iterate context, prefer href/src from the current item over recorded value.
          if (contextHandle) {
            const dynamicHref = await extractValue(page, effectiveSelector, 'href', contextHandle, step.text, preferPageContext);
            navTarget = resolveNavigationTarget(dynamicHref, page.url());
            if (!navTarget) {
              const dynamicSrc = await extractValue(page, effectiveSelector, 'src', contextHandle, step.text, preferPageContext);
              navTarget = resolveNavigationTarget(dynamicSrc, page.url());
            }

            // If the element handle is detached (common after navigation),
            // fall back to the precomputed per-item nav target.
            if (!navTarget && currentRecord) {
              const key = `__navTarget__${selectorCacheKey(effectiveSelector || step.selector || '')}`;
              if (currentRecord[key]) {
                navTarget = resolveNavigationTarget(currentRecord[key], page.url());
              }
            }
          }

          // Fallback to recorded navigation target when dynamic resolution is unavailable.
          if (!navTarget && !contextHandle) {
            // Outside iterate context, using the recorded href is acceptable.
            // Inside iterate context, we must not reuse a single recorded href
            // for all items; if dynamic resolution fails, we should click the
            // element within the current card context instead.
            navTarget = resolveNavigationTarget(step.value, page.url());
          }

          if (navTarget) {
            emitLog(`  Navigating via item link: ${navTarget}`);
            await page.goto(navTarget, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(500);
            break;
          }

          await clickWithFallbacks(page, effectiveSelector, step.text, contextHandle);
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
        } catch (err: any) {
          emitLog(`  ⚠️  Click failed: ${err.message}`);
        }
      }
      break;

    case 'fill':
      if (effectiveSelector) {
        emitLog(`Filling "${effectiveSelector}" with "${step.value || ''}"`);
        try {
          if (contextHandle) {
            const target = await contextHandle.$(effectiveSelector);
            if (target) {
              await target.fill(step.value || '');
            } else {
              await page.locator(effectiveSelector).first().fill(step.value || '', { timeout: 5000 });
            }
          } else {
            await page.locator(effectiveSelector).first().fill(step.value || '', { timeout: 5000 });
          }
        } catch (err: any) {
          emitLog(`  ⚠️  Fill failed: ${err.message}`);
        }
      }
      break;

    case 'extract':
      if (effectiveSelector && currentRecord) {
        const key = (step.label || effectiveSelector).trim();
        if (!contextHandle || preferPageContext) {
          await page.locator(effectiveSelector).first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
        }
        let value = await extractValue(
          page,
          effectiveSelector,
          step.attribute || 'textContent',
          contextHandle,
          // Use label (e.g. "BMI") as hint so generic value selectors
          // select the correct block.
          step.text || step.label,
          preferPageContext
        );
        const normalizedLabel = (step.label || '').trim().toLowerCase();
        if (normalizedLabel === 'id') {
          const hinted = donorTokenFromText(step.text);
          if (hinted && !/\bED\d{3,}\b/i.test(value) && !/\b\d{4,}\b/.test(value)) {
            value = hinted;
            emitLog(`  Using recorded text hint for "${key}"`);
          }
        }
        if (shouldRejectExtractedValue(step.label, value)) {
          emitLog(`  Selector result looked wrong for "${key}" ("${value}") — trying fallback`);
          value = '';
        }

        // Extra robustness for donor "id": even if the selector is slightly off,
        // try to infer an ED-code from the current context (card before click,
        // profile page after click).
        if (!value && normalizedLabel === 'id') {
          try {
            const sourceText = preferPageContext
              ? (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim()
              : ((await contextHandle?.textContent?.()) || '').replace(/\s+/g, ' ').trim();
            const inferred = donorTokenFromText(sourceText);
            if (inferred) {
              value = inferred;
              emitLog(`  Inferred "${key}" = "${inferred}" from page/card text`);
            }
          } catch {
            // ignore
          }
        }

        if (!value && !contextHandle && step.label) {
          const inferred = await inferValueByLabel(page, step.label);
          if (inferred) {
            value = inferred;
            emitLog(`  Fallback matched "${key}" from page text`);
          }
        }
        if (!value && !contextHandle && step.label) {
          const inferredFromCandidates = await inferFromSelectorCandidates(
            page,
            effectiveSelector,
            step.attribute || 'textContent',
            step.label
          );
          if (inferredFromCandidates) {
            value = inferredFromCandidates;
            emitLog(`  Fallback matched "${key}" from selector candidates`);
          }
        }
        currentRecord[key] = value;
        emitLog(`Extracted "${key}" = "${value.substring(0, 80)}${value.length > 80 ? '…' : ''}"`);
      }
      break;

    case 'wait':
      const ms = step.waitMs || 1000;
      emitLog(`Waiting ${ms}ms…`);
      await page.waitForTimeout(ms);
      break;

    case 'javascript':
      if (step.jsCode) {
        emitLog(`Executing JavaScript…`);
        try {
          const result = await runUserJavaScript(page, step.jsCode, contextHandle);
          emitLog(`  JS result: ${JSON.stringify(result)}`);

          if (currentRecord && result && typeof result === 'object' && !Array.isArray(result)) {
            for (const [k, v] of Object.entries(result)) {
              currentRecord[k] = typeof v === 'string' ? v : JSON.stringify(v);
            }
          }
        } catch (err: any) {
          emitLog(`  ⚠️  JS error: ${err.message}`);
        }
      }
      break;

    default:
      break;
  }
}

// ── Main scraper ──────────────────────────────────────────────────────────────
export const runScraper = async (
  jobId: string,
  emitLog: (msg: string) => void,
  emitData: (results: Record<string, string>[]) => void,
  config?: WorkflowConfig
) => {

  // ── Fallback to demo if no config provided ──────────────────────────────
  if (!config || !config.url) {
    emitLog('⚠️  No config provided — running demo scrape on example.com');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto('https://example.com');
      const title = await page.title();
      emitLog(`Title: ${title}`);
      emitData([{ title }]);
      return { success: true, results: [{ title }] };
    } finally {
      await browser.close();
    }
  }

  const { url, steps, extractionTemplate = [] } = config;
  const targetUrl = url;

  emitLog(`Starting browser…`);
  emitLog(`Scraper build: ${SCRAPER_BUILD}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  const allResults: Record<string, string>[] = [];
  const globalRecord: Record<string, string> = {};

  try {
    emitLog(`Navigating to ${url}…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for full JS rendering — same as the proxy session.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {
      emitLog('  (page still active after 8s — proceeding anyway)');
    });
    await page.waitForTimeout(500);
    const initialTitle = await page.title();
    emitLog(`Page loaded: ${initialTitle}`);

    // If the initial target requires auth, sites often bounce to sign-in first.
    // After successful login, we should revisit the original target URL so
    // extraction happens on the intended page even if nav clicks are brittle.
    const startedFromAuthGate =
      /sign\s*in|log\s*in/i.test(initialTitle) || /\/sign(in)?\b|\/login\b/i.test(page.url());
    let returnedToTargetAfterAuth = false;
    let forcedTargetBeforeExtract = false;

    let hasIterateStep = false;

    // ── Execute steps ───────────────────────────────────────────────────────
    for (const step of steps) {

      if (step.action === 'iterate') {
        hasIterateStep = true;
        const containerSel = step.selector || 'body';
        const itemSel = step.itemSelector || '*';

        emitLog(`Iterating over "${itemSel}" inside "${containerSel}"…`);

        let itemHandles: any[];
        const listingUrlAtStart = page.url();
        if (containerSel === 'body' || !containerSel) {
          itemHandles = await page.$$(itemSel);
        } else {
          const containerEl = await page.$(containerSel);
          if (containerEl) {
            itemHandles = await containerEl.$$(itemSel);
          } else {
            emitLog(`  ⚠️  Container "${containerSel}" not found — searching entire page`);
            itemHandles = await page.$$(itemSel);
          }
        }

        emitLog(`  Found ${itemHandles.length} items`);

        const noExtractionConfigured =
          (!step.iterateSteps || step.iterateSteps.length === 0) &&
          extractionTemplate.length === 0;

        // Precompute href/src navigation targets for click sub-steps
        // for ALL items before we execute any inner steps.
        // This avoids relying on element handles after the page navigates away.
        const precomputedNavTargetsByIndex: Record<number, Record<string, string>> = {};
        if (step.iterateSteps && step.iterateSteps.length > 0) {
          for (let i = 0; i < itemHandles.length; i++) {
            const handle = itemHandles[i];
            const navCache: Record<string, string> = {};

            for (const subStep of step.iterateSteps) {
              if (subStep.action !== 'click') continue;
              if (!subStep.selector) continue;

              const effectiveSubSelector = normalizeSelectorForItemContext(subStep.selector);
              const href = await extractValue(page, effectiveSubSelector, 'href', handle, subStep.text);
              const src = !href
                ? await extractValue(page, effectiveSubSelector, 'src', handle, subStep.text)
                : '';
              const navCandidate = href || src || '';
              if (navCandidate) {
                navCache[`__navTarget__${selectorCacheKey(effectiveSubSelector)}`] = navCandidate;
              }
            }

            precomputedNavTargetsByIndex[i] = navCache;
          }
        }

        const totalItems = itemHandles.length;
        for (let i = 0; i < totalItems; i++) {
          // Ensure we are back on the listing page before running any
          // card-level extraction steps for this item.
          if (page.url() !== listingUrlAtStart) {
            emitLog(`  Returning to listing for item ${i + 1}…`);
            await page.goto(listingUrlAtStart, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(300);

            // Re-query item handles so we don't depend on detached nodes.
            if (containerSel === 'body' || !containerSel) {
              itemHandles = await page.$$(itemSel);
            } else {
              const containerEl = await page.$(containerSel);
              itemHandles = containerEl ? await containerEl.$$(itemSel) : await page.$$(itemSel);
            }
          }

          const handle = itemHandles[i];
          if (!handle) {
            emitLog(`  ⚠️  Item ${i + 1}: missing element after reload — skipping`);
            continue;
          }

          const itemRecord: Record<string, string> = {
            _index: String(i + 1),
            ...(precomputedNavTargetsByIndex[i] || {})
          };

          // Execute any inner steps on the item
          if (step.iterateSteps && step.iterateSteps.length > 0) {
            let preferPageContext = false;
            for (const subStep of step.iterateSteps) {
              const urlBefore = page.url();
              await executeStep(page, subStep, emitLog, {
                contextHandle: handle,
                currentRecord: itemRecord,
                preferPageContext
              });

              // Once we navigate (e.g. click into donor profile), subsequent
              // extracts should be page-based, not listing-card-based.
              if (!preferPageContext && page.url() !== urlBefore) {
                preferPageContext = true;
              }
            }
          }

          // Extract fields from this item's context via template
          if (extractionTemplate.length > 0) {
            const templateRecord = await applyTemplate(page, extractionTemplate, handle);
            // Log which template fields came back empty so user can debug selectors
            for (const [k, v] of Object.entries(templateRecord)) {
              if (!v) emitLog(`  ⚠️  Field "${k}": selector returned nothing`);
            }
            Object.assign(itemRecord, templateRecord);
          }

          // Fallback: no extraction configured → capture text content so something is returned
          if (noExtractionConfigured) {
            try {
              const rawText = (await handle.textContent() || '').trim().replace(/\s+/g, ' ');
              if (rawText) itemRecord._text = rawText.substring(0, 500);
            } catch { /* ignore */ }
          }

          const hasData = Object.keys(itemRecord).length > 1; // more than just _index
          if (hasData) {
            allResults.push(itemRecord);
            const preview = JSON.stringify(itemRecord).substring(0, 200);
            emitLog(`  Item ${i + 1}: ${preview}${preview.length >= 200 ? '…' : ''}`);
          } else {
            try {
              const outerHtml = await handle.evaluate(
                (el: Element) => el.outerHTML.substring(0, 300)
              );
              emitLog(`  ⚠️  Item ${i + 1}: all selectors missed — item HTML: ${outerHtml}`);
            } catch {
              emitLog(`  ⚠️  Item ${i + 1}: all selectors missed`);
            }
          }
        }

        if (allResults.length === 0 && itemHandles.length > 0) {
          emitLog(`⚠️  Found ${itemHandles.length} items but 0 records extracted. Check that your selectors are relative to the item element (e.g. ".title" not ".container .card .title").`);
        }

      } else {
        if (
          startedFromAuthGate &&
          step.action === 'extract' &&
          !forcedTargetBeforeExtract &&
          page.url() !== targetUrl
        ) {
          emitLog(`Pre-extract guard — reopening target page: ${targetUrl}`);
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(500);
          emitLog(`Pre-extract page ready: ${page.url()}`);
          forcedTargetBeforeExtract = true;
        }

        await executeStep(page, step, emitLog, { currentRecord: globalRecord });

        if (startedFromAuthGate && !returnedToTargetAfterAuth) {
          const nowTitle = await page.title().catch(() => '');
          const stillOnAuthPage =
            /sign\s*in|log\s*in/i.test(nowTitle) || /\/sign(in)?\b|\/login\b/i.test(page.url());

          if (!stillOnAuthPage) {
            const sameUrl = page.url() === targetUrl;
            if (!sameUrl) {
              emitLog(`Auth detected — returning to original target: ${targetUrl}`);
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
              await page.waitForTimeout(500);
              emitLog(`Returned to target: ${page.url()}`);
            }
            returnedToTargetAfterAuth = true;
          }
        }
      }
    }

    // ── If no iterate step, extract from full page ──────────────────────────
    if (!hasIterateStep && extractionTemplate.length > 0) {
      emitLog(`Applying extraction template to full page…`);
      const record = await applyTemplate(page, extractionTemplate);
      Object.assign(globalRecord, record);
      allResults.push(globalRecord);
      emitLog(`  Extracted: ${JSON.stringify(globalRecord)}`);
    }

    // ── If no template at all, grab url + title as a minimal result ─────────
    if (extractionTemplate.length === 0 && !hasIterateStep) {
      if (Object.keys(globalRecord).length > 0) {
        // Preserve explicit extract/javascript outputs even without template.
        globalRecord.url = globalRecord.url || page.url();
        allResults.push(globalRecord);
        emitLog(`  No template — using step outputs: ${JSON.stringify(globalRecord)}`);
      } else {
        const record = {
          title: await page.title(),
          url: page.url()
        };
        allResults.push(record);
        emitLog(`  No template — extracted page title: "${record.title}"`);
      }
    }

    emitLog(`✅ Extraction complete — ${allResults.length} records`);
    emitData(allResults);

    return { success: true, results: allResults };

  } catch (error: any) {
    emitLog(`❌ Error: ${error.message}`);
    throw error;
  } finally {
    emitLog('Closing browser…');
    await browser.close();
  }
};
