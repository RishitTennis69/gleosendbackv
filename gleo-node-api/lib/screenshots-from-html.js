/**
 * Renders HTML in headless Chromium and captures up to 3 JPEG screenshots (top, middle, bottom).
 * Used for multimodal Gemini polish/critique. Requires: npx playwright install chromium
 */

const MAX_SHOTS = 3;
const VIEWPORT = { width: 1280, height: 800 };

function wrapHtmlDocument(html) {
  const h = String(html || '').trim();
  if (!h) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
  }
  if (/<html[\s>]/i.test(h)) {
    return h;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,sans-serif;padding:20px;max-width:960px;margin:0 auto;line-height:1.5;}</style></head><body>${h}</body></html>`;
}

/**
 * @param {string} htmlFragmentOrDocument
 * @param {{ max?: number }} [opts]
 * @returns {Promise<Buffer[]>} JPEG buffers, length 1..max
 */
async function captureHtmlScreenshots(htmlFragmentOrDocument, opts = {}) {
  const max = Math.min(MAX_SHOTS, Math.max(1, opts.max || MAX_SHOTS));
  let playwright;
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    playwright = require('playwright');
  } catch (e) {
    throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const doc = wrapHtmlDocument(htmlFragmentOrDocument);
    await page.setContent(doc, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const vh = VIEWPORT.height;
    const totalHeight = await page.evaluate(() =>
      Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        800
      )
    );

    const scrollYs = [];
    if (max >= 1) {
      scrollYs.push(0);
    }
    if (max >= 2 && totalHeight > vh * 1.2) {
      scrollYs.push(Math.max(0, Math.floor(totalHeight / 2 - vh / 2)));
    }
    if (max >= 3 && totalHeight > vh * 2) {
      scrollYs.push(Math.max(0, totalHeight - vh));
    }

    const uniqueYs = [...new Set(scrollYs)].slice(0, max);
    const buffers = [];

    for (const y of uniqueYs) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise((r) => setTimeout(r, 250));
      const buf = await page.screenshot({
        type: 'jpeg',
        quality: 72,
        fullPage: false,
      });
      if (Buffer.isBuffer(buf) && buf.length > 100) {
        buffers.push(buf);
      }
    }

    if (buffers.length === 0) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
      buffers.push(buf);
    }

    return buffers;
  } finally {
    await browser.close();
  }
}

module.exports = { captureHtmlScreenshots, MAX_SHOTS };
