import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.setContent('<main id="ready">playwright-ready</main>');
  const readyText = await page.textContent('#ready');

  if (readyText !== 'playwright-ready') {
    throw new Error('Playwright smoke page did not render expected text.');
  }

  console.log(`Playwright Chromium ready: ${chromium.executablePath()}`);
} finally {
  await browser.close();
}
