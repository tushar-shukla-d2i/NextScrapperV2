import { chromium } from 'playwright';

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
  contextHandle?: any
): Promise<string> {
  try {
    const ctx = contextHandle || page;
    const el = await ctx.$(selector);
    if (!el) return '';

    switch (attribute) {
      case 'textContent':
        return (await el.textContent() || '').trim();
      case 'innerHTML':
        return await el.innerHTML() || '';
      case 'value':
        return await el.inputValue().catch(() => '') || '';
      case 'href':
        return await el.getAttribute('href') || '';
      case 'src':
        return await el.getAttribute('src') || '';
      default:
        return await el.getAttribute(attribute) || '';
    }
  } catch {
    return '';
  }
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
    record[field.label] = await extractValue(page, field.selector, field.attribute, contextHandle);
  }
  return record;
}

// ── Execute a single step on the given page ───────────────────────────────────
async function executeStep(
  page: any,
  step: Step,
  emitLog: (msg: string) => void
): Promise<void> {
  switch (step.action) {

    case 'navigate':
      if (step.value) {
        emitLog(`Navigating to ${step.value}…`);
        await page.goto(step.value, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(500);
      }
      break;

    case 'click':
      if (step.selector) {
        emitLog(`Clicking "${step.selector}"…`);
        try {
          await page.click(step.selector, { timeout: 8000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
        } catch (err: any) {
          emitLog(`  ⚠️  Click failed: ${err.message}`);
        }
      }
      break;

    case 'fill':
      if (step.selector) {
        emitLog(`Filling "${step.selector}" with "${step.value || ''}"`);
        try {
          await page.locator(step.selector).first().fill(step.value || '', { timeout: 5000 });
        } catch (err: any) {
          emitLog(`  ⚠️  Fill failed: ${err.message}`);
        }
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
          const result = await page.evaluate(step.jsCode);
          emitLog(`  JS result: ${JSON.stringify(result)}`);
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

  emitLog(`Starting browser…`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  const allResults: Record<string, string>[] = [];

  try {
    emitLog(`Navigating to ${url}…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);
    emitLog(`Page loaded: ${await page.title()}`);

    let hasIterateStep = false;

    // ── Execute steps ───────────────────────────────────────────────────────
    for (const step of steps) {

      if (step.action === 'iterate') {
        hasIterateStep = true;
        const containerSel = step.selector || 'body';
        const itemSel = step.itemSelector || '*';

        emitLog(`Iterating over "${itemSel}" inside "${containerSel}"…`);

        const itemHandles = await page.$$(
          containerSel === 'body' || !containerSel
            ? itemSel
            : `${containerSel} ${itemSel}`
        );

        emitLog(`  Found ${itemHandles.length} items`);

        for (let i = 0; i < itemHandles.length; i++) {
          const handle = itemHandles[i];

          // Execute any inner steps on the item
          if (step.iterateSteps && step.iterateSteps.length > 0) {
            for (const subStep of step.iterateSteps) {
              if (subStep.action === 'click' && subStep.selector) {
                try {
                  await handle.$(subStep.selector).then((el: any) => el?.click());
                  await page.waitForTimeout(300);
                } catch {}
              }
            }
          }

          // Extract fields from this item's context
          if (extractionTemplate.length > 0) {
            const record = await applyTemplate(page, extractionTemplate, handle);
            // Only add non-empty records
            const hasData = Object.values(record).some(v => v.trim() !== '');
            if (hasData) {
              record['_index'] = String(i + 1);
              allResults.push(record);
              emitLog(`  Item ${i + 1}: ${JSON.stringify(record)}`);
            }
          }
        }

      } else {
        await executeStep(page, step, emitLog);
      }
    }

    // ── If no iterate step, extract from full page ──────────────────────────
    if (!hasIterateStep && extractionTemplate.length > 0) {
      emitLog(`Applying extraction template to full page…`);
      const record = await applyTemplate(page, extractionTemplate);
      allResults.push(record);
      emitLog(`  Extracted: ${JSON.stringify(record)}`);
    }

    // ── If no template at all, grab url + title as a minimal result ─────────
    if (extractionTemplate.length === 0 && !hasIterateStep) {
      const record = {
        title: await page.title(),
        url: page.url()
      };
      allResults.push(record);
      emitLog(`  No template — extracted page title: "${record.title}"`);
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
