const { GoogleGenAI } = require('@google/genai');
const { critiquePagePresentation } = require('./geo-analyzer');

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
 * Second-pass Gemini polish: improves readability while preserving WordPress block comments.
 */
async function polishPostContent({ title, html, layout_critique }) {
  if (!process.env.GOOGLE_GENAI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }
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

  let post_optimize_critique = null;
  try {
    post_optimize_critique = await critiquePagePresentation(parsed.polished_html, title, {
      optimizedVersion: true,
    });
  } catch (e) {
    console.error('[Polish] Post-optimize critique failed:', e.message);
  }

  return {
    polished_html: parsed.polished_html,
    short_summary: typeof parsed.short_summary === 'string' ? parsed.short_summary : '',
    post_optimize_critique,
  };
}

module.exports = { polishPostContent };
