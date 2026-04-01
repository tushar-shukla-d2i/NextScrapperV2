import { chromium } from 'playwright';

export const runScraper = async (jobId: string, emitLog: (msg: string) => void) => {
  emitLog('Starting browser...');
  const browser = await chromium.launch({ headless: true });
  // Add a simple delay to simulate slow boot up and show socket progress
  await new Promise(r => setTimeout(r, 1000));
  
  const page = await browser.newPage();
  
  try {
    emitLog('Navigating to https://example.com...');
    await page.goto('https://example.com');
    await page.waitForTimeout(2000); // Simulate work
    
    emitLog('Extracting title...');
    const title = await page.title();
    
    emitLog(`Finished extracting! Title is: ${title}`);
    
    return { success: true, title };
  } catch (error: any) {
    emitLog(`Error: ${error.message}`);
    throw error;
  } finally {
    emitLog('Closing browser...');
    await browser.close();
  }
};
