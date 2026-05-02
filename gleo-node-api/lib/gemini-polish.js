const { GoogleGenAI } = require('@google/genai');
const { critiquePagePresentation } = require('./geo-analyzer');
const { assertSafeWpRevision } = require('./html-safety');

let captureHtmlScreenshots = null;
function loadScreenshotHelper() {
  if (captureHtmlScreenshots) {
    return captureHtmlScreenshots;
  }
  try {
    // eslint-disable-next-line global-require
    captureHtmlScreenshots = require('./screenshots-from-html').captureHtmlScreenshots;
  } catch (e) {
    captureHtmlScreenshots = false;
  }
  return captureHtmlScreenshots;
}

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

function layoutCritiqueToText(layout_critique) {
  if (!layout_critique || typeof layout_critique !== 'object') return '';
  let t = '';
  if (layout_critique.overview) {
    t += `Summary: ${layout_critique.overview}\n`;
  }
  const issues = Array.isArray(layout_critique.issues) ? layout_critique.issues : [];
  issues.slice(0, 10).forEach((issue, i) => {
    const sev = issue.severity || 'medium';
    const cat = issue.category || 'Layout';
    const obs = issue.observation || '';
    const sug = issue.suggestion || '';
    t += `${i + 1}. [${sev}] ${cat}: ${obs} → ${sug}\n`;
  });
  return t.trim();
}

/**
 * Optional second pass: apply critique-backed fixes to HTML (text-only Gemini).
 */
async function repairHtmlFromCritique({ title, html, critique }) {
  const raw = typeof html === 'string' ? html : '';
  if (!raw.trim() || !critique) {
    return null;
  }
  const critText = JSON.stringify(critique).slice(0, 12000);
  const maxIn = 100000;
  let body = raw;
  if (body.length > maxIn) {
    body = body.slice(0, maxIn) + '\n<!-- gleo:content_truncated_for_model -->';
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `You revise WordPress post_content HTML using the critique JSON below.\n\n` +
              `Title: ${title || '(untitled)'}\n\n` +
              `Rules:\n` +
              `1) Preserve EVERY "<!-- wp:" and "<!-- /wp:" line count and order — same as input.\n` +
              `2) Apply concrete fixes implied by the critique (spacing, heading levels, duplicate wrappers, list/table hygiene). Do not remove factual sentences.\n` +
              `3) Do not add brand-new major sections.\n\n` +
              `CRITIQUE_JSON:\n${critText}\n\n` +
              `POST HTML:\n${body}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: 'You return strict JSON only. Never remove WordPress block comment lines.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          repaired_html: { type: 'STRING', description: 'Full post_content after applying critique fixes.' },
        },
        required: ['repaired_html'],
      },
      maxOutputTokens: 65536,
    },
  });

  const parsed = JSON.parse(response.text);
  if (!parsed || typeof parsed.repaired_html !== 'string' || !parsed.repaired_html.trim()) {
    return null;
  }
  return parsed.repaired_html;
}

/**
 * Multimodal: up to 3 JPEGs + HTML → polished HTML + summary + critique in one call.
 */
async function polishVisualMultimodal({ title, html, layout_critique }) {
  const helper = loadScreenshotHelper();
  if (!helper || typeof helper !== 'function') {
    throw new Error('screenshots helper unavailable');
  }

  const raw = typeof html === 'string' ? html : '';
  if (!raw.trim()) {
    throw new Error('Empty post content');
  }

  const jpegBuffers = await helper(raw, { max: 3 });
  const maxIn = 80000;
  let body = raw;
  if (body.length > maxIn) {
    body = body.slice(0, maxIn) + '\n<!-- gleo:content_truncated_for_model -->';
  }

  const critiqueBlock = layoutCritiqueToText(layout_critique) || '(No prior layout notes.)';

  const parts = [];
  for (const buf of jpegBuffers) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64'),
      },
    });
  }

  parts.push({
    text:
      `You polish a WordPress article. Up to ${jpegBuffers.length} JPEGs show how the page currently LOOKS (layout, spacing, crowding). The HTML below is the source of truth for text and block structure.\n\n` +
      `Title: ${title || '(untitled)'}\n\n` +
      `Prior notes:\n${critiqueBlock}\n\n` +
      `Rules:\n` +
      `1) Keep EVERY "<!-- wp:" and "<!-- /wp:" line — same count and ORDER as the HTML.\n` +
      `2) Fix presentation using BOTH the images and HTML (spacing, hierarchy, awkward breaks).\n` +
      `3) Do not remove real sentences or change language. No new major sections.\n` +
      `4) post_optimize_critique: overview + issues with observation + how_to_fix-style suggestion steps.\n\n` +
      `Return JSON with polished_html, short_summary, post_optimize_critique.\n\n` +
      `POST HTML:\n${body}`,
  });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction:
        'You return strict JSON only. Images are for layout only; never invent facts not in the HTML. Preserve WordPress block comments exactly.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          polished_html: { type: 'STRING', description: 'Full post_content after polish.' },
          short_summary: { type: 'STRING', description: 'One short sentence for the site owner.' },
          post_optimize_critique: {
            type: 'OBJECT',
            properties: {
              overview: { type: 'STRING' },
              strengths: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional; up to 3 strengths.',
              },
              issues: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    severity: { type: 'STRING', enum: ['low', 'medium', 'high'] },
                    category: { type: 'STRING' },
                    observation: { type: 'STRING' },
                    suggestion: { type: 'STRING' },
                  },
                  required: ['severity', 'category', 'observation', 'suggestion'],
                },
              },
            },
            required: ['overview', 'issues'],
          },
        },
        required: ['polished_html', 'short_summary', 'post_optimize_critique'],
      },
      maxOutputTokens: 65536,
    },
  });

  const parsed = JSON.parse(response.text);
  if (!parsed || typeof parsed.polished_html !== 'string' || !parsed.polished_html.trim()) {
    throw new Error('Gemini returned empty polish result');
  }

  const safe = assertSafeWpRevision(raw, parsed.polished_html, { minRatio: 0.88 });
  if (!safe.ok) {
    throw new Error(`Polish failed safety: ${safe.reason}`);
  }

  let outHtml = parsed.polished_html;
  let critique = parsed.post_optimize_critique && typeof parsed.post_optimize_critique === 'object'
    ? parsed.post_optimize_critique
    : null;
  if (critique && Array.isArray(critique.issues)) {
    critique.issues = critique.issues.filter((x) => x && x.observation && x.suggestion).slice(0, 8);
  }
  if (critique && !Array.isArray(critique.strengths)) {
    critique.strengths = [];
  }

  const autoRepair = process.env.GLEO_AUTO_REPAIR_FROM_CRITIQUE === '1';
  if (autoRepair && critique && Array.isArray(critique.issues) && critique.issues.length > 0) {
    try {
      const repaired = await repairHtmlFromCritique({ title, html: outHtml, critique });
      if (repaired && repaired.trim()) {
        const safe2 = assertSafeWpRevision(outHtml, repaired, { minRatio: 0.88 });
        if (safe2.ok) {
          outHtml = repaired;
        } else {
          console.warn('[Polish] Auto-repair rejected by safety:', safe2.reason);
        }
      }
    } catch (e) {
      console.warn('[Polish] Auto-repair skipped:', e.message);
    }
  }

  return {
    polished_html: outHtml,
    short_summary: typeof parsed.short_summary === 'string' ? parsed.short_summary : '',
    post_optimize_critique: critique,
  };
}

/**
 * Legacy: text-only polish then separate critique call.
 */
async function polishTextOnlyTwoStep({ title, html, layout_critique }) {
  const raw = typeof html === 'string' ? html : '';
  if (!raw.trim()) {
    throw new Error('Empty post content');
  }

  const maxIn = 120000;
  let body = raw;
  if (body.length > maxIn) {
    body = body.slice(0, maxIn) + '\n<!-- gleo:content_truncated_for_model -->';
  }

  const critiqueBlock = layoutCritiqueToText(layout_critique) || '(No separate layout notes — focus on clean HTML and balanced sections.)';

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `You help polish a WordPress article that already has Gleo GEO blocks.\n\n` +
              `Title: ${title || '(untitled)'}\n\n` +
              `Layout review notes (use as guidance):\n${critiqueBlock}\n\n` +
              `Rules:\n` +
              `1) Keep EVERY WordPress block delimiter exactly: every "<!-- wp:" and "<!-- /wp:" line must stay the SAME count and ORDER as in the original. Never delete, add, or merge block comment lines.\n` +
              `2) Inside HTML you may fix: broken tags, extra blank paragraphs, uneven spacing, poorly nested lists/tables, awkward headings inside fragments, duplicate wrappers.\n` +
              `3) Do NOT remove real sentences or factual paragraphs. Do NOT change the article language.\n` +
              `4) Do NOT add brand‑new major sections; only tighten presentation.\n\n` +
              `Return JSON with polished_html (full post_content string) and short_summary (one plain-language sentence for the site owner).\n\n` +
              `POST CONTENT:\n${body}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction:
        'You return strict JSON only. Preserving WordPress block comments exactly is the highest priority.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          polished_html: { type: 'STRING', description: 'Full WordPress post_content after polish.' },
          short_summary: {
            type: 'STRING',
            description: 'One short sentence in simple words explaining what you improved.',
          },
        },
        required: ['polished_html', 'short_summary'],
      },
      maxOutputTokens: 65536,
    },
  });

  const parsed = JSON.parse(response.text);
  if (!parsed || typeof parsed.polished_html !== 'string' || !parsed.polished_html.trim()) {
    throw new Error('Gemini returned empty polish result');
  }

  const safe = assertSafeWpRevision(raw, parsed.polished_html, { minRatio: 0.88 });
  if (!safe.ok) {
    throw new Error(`Polish failed safety: ${safe.reason}`);
  }

  let post_optimize_critique = null;
  try {
    post_optimize_critique = await critiquePagePresentation(parsed.polished_html, title, {
      optimizedVersion: true,
    });
  } catch (e) {
    console.error('[Polish] Post-optimize critique failed:', e.message);
  }

  let outHtml = parsed.polished_html;
  const autoRepair = process.env.GLEO_AUTO_REPAIR_FROM_CRITIQUE === '1';
  if (autoRepair && post_optimize_critique && Array.isArray(post_optimize_critique.issues) && post_optimize_critique.issues.length > 0) {
    try {
      const repaired = await repairHtmlFromCritique({ title, html: outHtml, critique: post_optimize_critique });
      if (repaired && repaired.trim()) {
        const safe2 = assertSafeWpRevision(outHtml, repaired, { minRatio: 0.88 });
        if (safe2.ok) {
          outHtml = repaired;
        } else {
          console.warn('[Polish] Auto-repair rejected by safety:', safe2.reason);
        }
      }
    } catch (e) {
      console.warn('[Polish] Auto-repair skipped:', e.message);
    }
  }

  return {
    polished_html: outHtml,
    short_summary: typeof parsed.short_summary === 'string' ? parsed.short_summary : '',
    post_optimize_critique,
  };
}

/**
 * Polish + critique (+ optional repair). Set GLEO_VISUAL_POLISH=0 to skip screenshots (text-only two-step + separate critique).
 */
async function polishPostContent({ title, html, layout_critique }) {
  if (!process.env.GOOGLE_GENAI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }

  const useVisual = process.env.GLEO_VISUAL_POLISH !== '0';
  if (useVisual) {
    try {
      return await polishVisualMultimodal({ title, html, layout_critique });
    } catch (e) {
      console.warn('[Polish] Visual multimodal path failed, falling back to text-only:', e.message);
    }
  }

  return polishTextOnlyTwoStep({ title, html, layout_critique });
}

module.exports = { polishPostContent };
