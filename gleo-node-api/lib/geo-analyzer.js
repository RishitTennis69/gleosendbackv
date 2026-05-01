const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

const GENERIC_COPY_PATTERNS = [
  /awaken your senses/i,
  /finest artisanal/i,
  /perfect morning/i,
  /why choose us/i,
  /deeper dive/i,
  /elevate your/i,
  /crafted with passion/i,
  /unleash/i,
  /experience the/i,
];

function looksGenericCopy(html = '') {
  if (!html || typeof html !== 'string') return false;
  return GENERIC_COPY_PATTERNS.some((re) => re.test(html));
}

/** Instructional / editor-placeholder “statistics” the model must not emit (or we strip). */
function looksStatInstructionPlaceholder(text = '') {
  const t = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return ['add a verified', 'source-backed metric', 'figure and source name', 'verified, source-backed', 'include the figure'].some((n) => t.includes(n));
}

function escapeHtmlPlain(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** When Gemini emits banned filler or empty strings, keep other assets instead of dropping the whole bundle. */
function buildFallbackFaqHtml(title) {
  const t = escapeHtmlPlain(String(title || 'this topic').slice(0, 160));
  return (
    `<h2>Quick answers</h2>` +
    `<h3>What does this article cover?</h3>` +
    `<p>It explains ${t} in practical terms—use the headings above to jump to any section.</p>` +
    `<h3>How should I use this page?</h3>` +
    `<p>Use it as a reference alongside your own requirements and any rules that apply to you.</p>`
  );
}

/** Marketing-style matrix filler the model must not use in comparison tables. */
function looksGenericTemplateTable(html) {
  const t = String(html || '').toLowerCase();
  if (!/<\s*table/i.test(t)) {
    return false;
  }
  if (t.includes('primary benefit') && t.includes('secondary benefit')) {
    return true;
  }
  const needles = ['key advantage related', 'additional value point', 'important factor to evaluate'];
  let hits = 0;
  for (const n of needles) {
    if (t.includes(n)) {
      hits++;
    }
  }
  if (hits >= 2) {
    return true;
  }
  if (/\bhigh\b[\s\S]{0,120}\bmedium\b[\s\S]{0,120}\bvaries\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Real sentences from the excerpt — no “Primary Benefit / High” placeholders. */
function buildDataTableFromExcerpt(title, excerpt) {
  const text = String(excerpt || '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30)
    .slice(0, 4);
  const rows = parts.length ? parts : [text.slice(0, 400) || 'See the article body for specifics.'];
  let rowsHtml = '';
  rows.forEach((s, i) => {
    rowsHtml += `<tr><td>Takeaway ${i + 1}</td><td>${escapeHtmlPlain(s.slice(0, 280))}</td></tr>`;
  });
  return `<figure class="wp-block-table"><table class="gleo-data-table"><thead><tr><th>Topic angle</th><th>From this article</th></tr></thead><tbody>${rowsHtml}</tbody></table></figure>`;
}

function contextualAssetFallback(key, title, excerpt = '') {
  const t = escapeHtmlPlain(String(title || '').slice(0, 120));
  switch (key) {
    case 'faq_html':
      return buildFallbackFaqHtml(title);
    case 'authority_html':
      return '<p></p>';
    case 'data_table_html':
      if (excerpt && String(excerpt).trim().length > 50) {
        return buildDataTableFromExcerpt(title, excerpt);
      }
      return `<figure class="wp-block-table"><table class="gleo-data-table"><thead><tr><th>Focus</th><th>Summary</th></tr></thead><tbody><tr><td>${t}</td><td>Use the headings above for the full explanation.</td></tr></tbody></table></figure>`;
    case 'depth_html':
      return `<h2>More detail on ${t}</h2><p>Expand on the points above with specifics your readers can act on.</p>`;
    case 'qa_html':
      return `<p><strong>What is the main idea?</strong></p><p>The article walks through ${t} step by step in the sections above.</p>`;
    default:
      return '';
  }
}

function sanitizeContextualAssets(assets, title = '', excerpt = '') {
  if (!assets || typeof assets !== 'object') return null;
  const keys = ['data_table_html', 'faq_html', 'depth_html', 'qa_html', 'authority_html'];
  const out = { ...assets };
  for (const key of keys) {
    const raw = out[key];
    const missing = !raw || typeof raw !== 'string' || !String(raw).trim();
    const generic = !missing && looksGenericCopy(raw);
    let bad = missing || generic;
    if (key === 'data_table_html' && !missing && looksGenericTemplateTable(raw)) {
      bad = true;
    }
    if (bad) {
      out[key] = contextualAssetFallback(key, title, excerpt);
    }
  }
  for (const key of keys) {
    if (!out[key] || typeof out[key] !== 'string' || !String(out[key]).trim()) {
      return null;
    }
  }
  if (looksStatInstructionPlaceholder(out.authority_html)) {
    out.authority_html = '<p></p>';
  }
  return out;
}

/**
 * Builds a bounded payload for layout/readability critique (tokens).
 */
function buildLayoutCritiquePayload(htmlContent, title) {
  const $ = cheerio.load(htmlContent || '');
  let container = $('.entry-content, .wp-block-post-content, article').first();
  if (!container.length) {
    container = $('body');
  }
  const headingOutline = [];
  container.find('h1,h2,h3,h4').each((i, el) => {
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (t && headingOutline.length < 36) {
      headingOutline.push(`${el.tagName.toLowerCase()}: ${t}`);
    }
  });
  const clone = container.clone();
  clone.find('script, style, noscript, iframe').remove();
  let snippet = clone.html() || '';
  snippet = snippet.replace(/\s+/g, ' ').trim().substring(0, 7500);
  const cloneText = container.clone();
  cloneText.find('script, style, noscript, iframe').remove();
  const plainExcerpt = cloneText.text().replace(/\s+/g, ' ').trim().substring(0, 4000);
  const inlineStyleAttrs = (snippet.match(/\sstyle\s*=/gi) || []).length;
  const imgCount = container.find('img').length;
  const tableCount = container.find('table').length;
  return {
    title: title || '',
    heading_outline: headingOutline,
    text_excerpt: plainExcerpt,
    html_structure_snippet: snippet,
    counts: { images: imgCount, tables: tableCount, inline_style_attributes_approx: inlineStyleAttrs },
  };
}

/**
 * AI critique of how the page reads and presents (before user sees live preview optimisations).
 * Returns null if Gemini is unavailable or fails.
 */
async function critiquePagePresentation(htmlContent, title, options = {}) {
  if (!process.env.GOOGLE_GENAI_API_KEY) {
    return null;
  }
  const payload = buildLayoutCritiquePayload(htmlContent, title);
  const optimizedNote = options.optimizedVersion
    ? 'This HTML is the post AFTER Gleo optimize + Gemini polish — critique what is left to improve on this version only.\n\n'
    : '';
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{
            text: `${optimizedNote}You review a WordPress article page for human readability and visual/layout quality as inferred from HTML structure and text.\n\nInput JSON:\n${JSON.stringify(payload)}\n\nCritique ONLY presentation: heading hierarchy and scanability, paragraph length rhythm, list/table usage, sense of balanced sections, repetitive or generic filler, risky contrast if suggested by markup (e.g. light text classes on dark wrappers), broken or uneven columns/layout patterns, and accessibility hints (e.g. missing alt where images exist). Do NOT discuss JSON-LD, meta tags, or GEO scoring. Do NOT invent facts not supported by the excerpt. Be specific to this article.\n\nReturn strict JSON matching the schema.`,
          }],
        },
      ],
      config: {
        systemInstruction: 'You are a meticulous editor and UI reviewer for content-heavy sites. Prefer concrete, actionable observations over vague praise. Severity high means it likely hurts comprehension or trust.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            overview: { type: 'STRING', description: '2–4 sentences summarizing overall presentation quality.' },
            strengths: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Up to 3 specific strengths grounded in the supplied outline/snippet.',
            },
            issues: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  severity: { type: 'STRING', enum: ['low', 'medium', 'high'] },
                  category: { type: 'STRING', description: 'Short label e.g. Hierarchy, Spacing, Typography, Columns' },
                  observation: { type: 'STRING', description: 'What is wrong, tied to this page.' },
                  suggestion: { type: 'STRING', description: 'Concrete fix direction (not full HTML).' },
                },
                required: ['severity', 'category', 'observation', 'suggestion'],
              },
              description: 'Ordered most important first; max 8 items.',
            },
          },
          required: ['overview', 'issues'],
        },
      },
    });
    const parsed = JSON.parse(response.text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.issues)) parsed.issues = [];
    if (!Array.isArray(parsed.strengths)) parsed.strengths = [];
    parsed.strengths = parsed.strengths.filter(Boolean).slice(0, 3);
    parsed.issues = parsed.issues.filter((x) => x && x.observation && x.suggestion).slice(0, 8);
    return parsed;
  } catch (err) {
    console.error('[GEO] Layout critique failed:', err.message);
    return null;
  }
}

/**
 * Generates specifically contextual HTML elements dynamically based on the post.
 */
async function generateContextualAssets(title, content) {
  const $ = cheerio.load(content || '');
  $('script, style, noscript, svg, path, iframe, nav, footer, header, aside').remove();
  const plainText = $('body').text().replace(/\s+/g, ' ').substring(0, 3000).trim();
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: `Article title: ${title}\nArticle excerpt (from the page): ${plainText}\n\nWrite HTML snippets this site could paste into WordPress. Stay tightly on the article's real subject and facts from the excerpt. Do not use meta filler, SEO clichés, or template phrases (avoid wording like: "key details", "what you need to know", "deep dive", "key takeaways", "important considerations", "really", duplicated phrases, or headings that sound like a content mill).\n\nNever output instructional placeholder text about statistics (for example do not write "add a verified", "source-backed metric", "figure and source name", or similar editor prompts). For authority_html, either use real numbers clearly grounded in the excerpt or write an empty <p></p>.\n\nNever write marketing slogans or ad copy. Specifically avoid lines like "awaken your senses", "experience the finest", "perfect morning", "crafted with passion", "why choose us", or similar promo language.\n\nFor data_table_html specifically:\n- Every row must quote concrete ideas from the excerpt or restate them in plain words tied to this topic.\n- Forbidden: abstract rows like "Primary Benefit", "Secondary Benefit", "Consideration", "Key advantage related to…", "Additional value point", "Important factor to evaluate", or priority cells that are only "High", "Medium", "Varies", "Impact" columns filled with filler. Use real comparisons (e.g. named options, steps, or facts from the article), not a generic benefits matrix.\n\nFormatting rules:\n- Keep visual hierarchy clean: main section titles are H2; sub-sections inside cards/columns should be H3 or H4 (not H2).\n- Never use inline fixed heights/min-heights/overflow clipping styles.\n- If you output multi-column or multi-card content, keep each column structurally parallel (same type of container, similar heading level + paragraph/list pattern).\n- Ensure link and text colors stay readable on dark backgrounds (high contrast, no dark text on dark backgrounds).\n- Table headers must be concise and prominent.\n\nInclude: (1) a comparison table in <figure class=\"wp-block-table\"><table>...</table></figure>, (2) a short FAQ (one clear H2 title + H3 questions + answers), (3) one extra section (H2 + paragraph) that continues the article substance, (4) a compact Q&A block, (5) one paragraph of plausible, topic-relevant statistics written as normal sentences (no heading).` }] }
      ],
      config: {
        systemInstruction: "You are an experienced web editor and accessibility-minded frontend writer. Output valid, minimal HTML fragments suitable for WordPress. Use only the supplied title and excerpt; be specific and natural. Never use generic SEO headings, marketing slogans, or repetitive filler. Keep structure balanced, readable, and semantically correct. Return strict JSON only.",
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            data_table_html: { type: "STRING", description: "Concrete comparison rows grounded in the excerpt (no generic benefit/impact matrix). <figure class=\"wp-block-table\"><table>...</table></figure>." },
            faq_html: { type: "STRING", description: "FAQ: one concrete H2 title + 2–3 H3 questions with <p> answers; wording must match the article topic." },
            depth_html: { type: "STRING", description: "One H2 (specific to the topic, not a generic label) plus one <p> that adds useful detail grounded in the excerpt." },
            qa_html: { type: "STRING", description: "Short Q&A block: natural question heading plus direct answer paragraph about the article's core idea." },
            authority_html: { type: "STRING", description: "Single <p> only: 2–3 real numeric statistics grounded in the excerpt as flowing prose; never instructions to the editor; use <p></p> if no numbers exist in the excerpt." }
          },
          required: ["data_table_html", "faq_html", "depth_html", "qa_html", "authority_html"]
        }
      }
    });
    
    try {
      return sanitizeContextualAssets(JSON.parse(response.text), title, plainText);
    } catch (e) {
      console.error('[GEO] Failed to parse Gemini response:', e.message);
      throw new Error("Gemini parsing failed");
    }
  } catch (err) {
    console.error('[GEO] Gemini API failed:', err.message);
    return null;
  }
}

/**
 * Analyzes a single post for Generative Engine Optimization (GEO).
 * Uses Tavily to understand how AI engines see the post's topic,
 * then scores the post and generates actionable recommendations based on live HTML.
 *
 * @param {Object} post - { id, title, content (Live HTML) }
 * @param {string} siteUrl - The WordPress site URL for brand detection
 * @returns {Object} Full GEO report for this post
 */
async function analyzePost(post, siteUrl = '') {
  const { id, title, content } = post;
  console.log(`  [GEO] Analyzing post ${id}: "${title}"`);

  // --- Step 1: Tavily Search - How do AI engines respond to this topic? ---
  let tavilyResults = [];
  try {
    const searchQuery = title.length > 10 ? title : `${title} ${content.substring(0, 100)}`;
    const response = await axios.post(TAVILY_SEARCH_URL, {
      api_key: TAVILY_API_KEY,
      query: searchQuery,
      search_depth: 'advanced',
      include_answer: true,
      include_raw_content: false,
      max_results: 5
    });
    tavilyResults = response.data.results || [];
    console.log(`  [GEO] Tavily returned ${tavilyResults.length} results for "${title}"`);
  } catch (err) {
    console.error(`  [GEO] Tavily search failed for post ${id}:`, err.message);
  }

  // --- Step 2: Brand Inclusion Rate (0-10) ---
  const brandInclusionRate = calculateBrandInclusion(tavilyResults, siteUrl, title);

  // --- Step 3: Content Quality Signals (HTML Parsing) ---
  const contentSignals = analyzeContentSignals(content, title);

  // --- Step 4: GEO Score (0-100) ---
  const geoScore = calculateGeoScore(contentSignals, brandInclusionRate, tavilyResults);

  // --- Step 5: Generate JSON-LD Schema ---
  const jsonLdSchema = generateJsonLd(title, content, siteUrl);
  
  // --- Step 6: Contextual assets (layout critique runs only after Optimize in the preview flow) ---
  const contextualAssets = await generateContextualAssets(title, content);

  // --- Step 7: Build Specific Recommendations (Granular Scoring) ---
  const recommendations = generateRecommendations(contentSignals, brandInclusionRate, geoScore);

  return {
    id,
    data: {
      title,
      geo_score: geoScore,
      brand_inclusion_rate: brandInclusionRate,
      json_ld_schema: jsonLdSchema,
      contextual_assets: contextualAssets,
      recommendations,
      content_signals: contentSignals,
      ai_landscape: tavilyResults.slice(0, 3).map(r => ({
        title: r.title,
        url: r.url,
        relevance: r.score ? Math.round(r.score * 100) : null
      }))
    }
  };
}

/**
 * Calculates Brand Inclusion Rate (0-10).
 * Measures how visible the brand/site is in AI-generated search results.
 */
function calculateBrandInclusion(results, siteUrl, postTitle) {
  if (!results.length) return 0;

  let score = 0;
  const siteDomain = siteUrl ? new URL(siteUrl).hostname.replace('www.', '') : '';
  const titleWords = postTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  for (const result of results) {
    const resultText = `${result.title || ''} ${result.content || ''} ${result.url || ''}`.toLowerCase();

    // Direct domain match (strongest signal)
    if (siteDomain && resultText.includes(siteDomain)) {
      score += 3;
    }

    // Title keyword overlap (moderate signal)
    const matchingWords = titleWords.filter(w => resultText.includes(w));
    if (matchingWords.length >= 2) {
      score += 1;
    }
  }

  return Math.min(10, Math.round(score));
}

/**
 * Analyzes the post live HTML for the 5-pillar GEO quality signals using Cheerio.
 */
function analyzeContentSignals(htmlContent, title) {
  const $ = cheerio.load(htmlContent || '');
  
  // Re-load original HTML to check head for schema
  const $full = cheerio.load(htmlContent || '');
  
  // Remove noise
  $('script, style, noscript, nav, footer, header, aside').remove();
  const plainText = $('body').text() || '';
  const cleanText = plainText.replace(/\s+/g, ' ').trim();
  const wordCount = cleanText.split(/\s+/).filter(w => w.length > 0).length;

  // ── 1. Technical Crawlability ──
  const images = $('img');
  const imageCount = images.length;
  const imagesWithAlt = images.filter((i, el) => {
    const alt = $(el).attr('alt');
    return alt && alt.trim().length > 3;
  }).length;
  const altTextCoverage = imageCount > 0 ? Math.round((imagesWithAlt / imageCount) * 100) : 100;
  
  const hasMetaRobotsBlock = $full('meta[name="robots"][content*="noindex"]').length > 0 ||
                              $full('meta[name="robots"][content*="nofollow"]').length > 0;
  const hasLlmsTxtRef = /llms\.txt/i.test(htmlContent);

  // ── 2. Structured Data & Schema ──
  const schemaScripts = $full('script[type="application/ld+json"]');
  const hasSchema = schemaScripts.length > 0;
  let hasFaqSchema = false;
  let hasOrgSchema = false;
  schemaScripts.each((i, el) => {
    const txt = $(el).text();
    if (/FAQPage/i.test(txt)) hasFaqSchema = true;
    if (/Organization|LocalBusiness|Product|Person/i.test(txt)) hasOrgSchema = true;
  });

  // ── 3. Content Quality ──
  const paragraphs = $('p').map((i, el) => $(el).text().trim()).get().filter(p => p.length > 20);
  const avgParagraphLength = paragraphs.length > 0
    ? Math.round(paragraphs.reduce((sum, p) => sum + p.split(/\s+/).length, 0) / paragraphs.length)
    : 0;
  
  // Direct answer detection: first substantial paragraph is 60-100 words (inverted pyramid)
  const firstParaWords = paragraphs.length > 0 ? paragraphs[0].split(/\s+/).length : 0;
  const hasDirectAnswer = firstParaWords >= 40 && firstParaWords <= 120;
  
  // Conversational query targeting
  const hasConversationalQueries = /\b(best|how to|what is|why|can i|should i|compared to|vs\.?|for a)\b/i.test(cleanText);
  
  // Check for TL;DR or summary blocks
  const hasTldr = /tl;?dr|at a glance|quick answer|in\s+brief/i.test(cleanText);
  
  const hasDirectAnswers = /\b(is|are|was|were|can|does|do|will|how|what|why|when|where)\b[^.?]*\?/i.test(cleanText);

  // ── 4. Credibility ──
  const statsMatches = cleanText.match(/\d+%|\d+\s*(percent|million|billion|thousand)/ig);
  const statCount = statsMatches ? statsMatches.length : 0;
  const hasStatistics = statCount > 0;
  
  const citationCount = $('a[href^="http"]').length;
  const hasCitations = citationCount > 0;
  
  const hasQuotes = $('blockquote').length > 0 || /"[^"]{20,}"/.test(cleanText);

  // ── 5. AI-Specific Formatting ──
  const headingCount = $('h2, h3, h4, h5, h6').length;
  const hasHeadings = headingCount > 0;
  
  const listCount = $('ul, ol').length;
  const hasList = listCount > 0;
  
  const hasTable = $('table').length > 0;
  
  const hasFAQ = /faq|frequently\s+asked|common\s+questions/i.test(cleanText);
  
  // Long paragraph detection (paragraphs > 80 words)
  const longParagraphs = paragraphs.filter(p => p.split(/\s+/).length > 80).length;

  return {
    word_count: wordCount,
    // Technical
    image_count: imageCount,
    images_with_alt: imagesWithAlt,
    alt_text_coverage: altTextCoverage,
    has_meta_robots_block: hasMetaRobotsBlock,
    has_llms_txt: hasLlmsTxtRef,
    // Schema
    has_schema: hasSchema,
    has_faq_schema: hasFaqSchema,
    has_org_schema: hasOrgSchema,
    // Content Quality
    has_direct_answer: hasDirectAnswer,
    has_conversational_queries: hasConversationalQueries,
    has_tldr: hasTldr,
    has_direct_answers: hasDirectAnswers,
    first_para_words: firstParaWords,
    // Credibility
    has_statistics: hasStatistics,
    stat_count: statCount,
    has_citations: hasCitations,
    citation_count: citationCount,
    has_quotes: hasQuotes,
    // AI Formatting
    has_headings: hasHeadings,
    heading_count: headingCount,
    has_lists: hasList,
    list_item_count: listCount,
    has_table: hasTable,
    has_faq: hasFAQ,
    has_images: imageCount > 0,
    paragraph_count: paragraphs.length,
    avg_paragraph_length: avgParagraphLength,
    long_paragraphs: longParagraphs
  };
}

/**
 * Calculates the overall GEO score (0-100) using the 5-pillar framework.
 */
function calculateGeoScore(signals, brandRate, tavilyResults) {
  let score = 0;

  // ── 1. Technical Crawlability (max 15) ──
  // Alt text coverage: 5 pts
  if (signals.alt_text_coverage >= 90) score += 5;
  else if (signals.alt_text_coverage >= 50) score += 3;
  else if (signals.image_count === 0) score += 5; // No images = no penalty
  
  // No robots blocking: 5 pts
  if (!signals.has_meta_robots_block) score += 5;
  
  // llms.txt: 5 pts
  if (signals.has_llms_txt) score += 5;

  // ── 2. Structured Data & Schema (max 20) ──
  if (signals.has_schema) score += 10;
  if (signals.has_faq_schema) score += 5;
  if (signals.has_org_schema) score += 5;

  // ── 3. Content Quality (max 30) ──
  // Depth: 10 pts
  if (signals.word_count >= 2000) score += 10;
  else if (signals.word_count >= 1200) score += 7;
  else if (signals.word_count >= 600) score += 4;
  else if (signals.word_count > 0) score += 1;
  
  // Direct answer / inverted pyramid: 10 pts
  if (signals.has_direct_answer) score += 5;
  if (signals.has_tldr) score += 5;
  
  // Conversational query targeting: 5 pts
  if (signals.has_conversational_queries) score += 3;
  if (signals.has_direct_answers) score += 2;
  
  // Content specificity: 5 pts
  if (signals.word_count >= 800 && signals.has_statistics) score += 3;
  if (signals.has_quotes) score += 2;

  // ── 4. Credibility (max 15) ──
  // Statistics: 5 pts
  if (signals.stat_count >= 3) score += 5;
  else if (signals.stat_count >= 1) score += 3;
  
  // Outbound citations: 5 pts
  if (signals.citation_count >= 3) score += 5;
  else if (signals.citation_count >= 1) score += 3;
  
  // Expert quotes: 5 pts
  if (signals.has_quotes) score += 5;

  // ── 5. AI-Specific Formatting (max 20) ──
  // Semantic headings: 5 pts
  if (signals.heading_count >= 4) score += 5;
  else if (signals.heading_count >= 2) score += 3;
  else if (signals.has_headings) score += 1;
  
  // Short paragraphs: 5 pts
  if (signals.long_paragraphs === 0 && signals.paragraph_count > 0) score += 5;
  else if (signals.long_paragraphs <= 2) score += 3;
  
  // Lists: 4 pts
  if (signals.list_item_count >= 3) score += 4;
  else if (signals.has_lists) score += 2;

  // FAQ block: 3 pts
  if (signals.has_faq) score += 3;
  
  // Comparison tables: 3 pts
  if (signals.has_table) score += 3;

  return Math.min(100, score);
}

// Answer Capsule function removed per user request

/**
 * Generates JSON-LD structured data schema for the post.
 */
function generateJsonLd(title, content, siteUrl) {
  const $ = cheerio.load(content || '');
  $('script, style, noscript, svg, path, iframe, nav, footer, header, aside').remove();

  const articleRoot =
    $('.entry-content').first().length ? $('.entry-content').first() :
    $('.wp-block-post-content').first().length ? $('.wp-block-post-content').first() :
    $('article').first().length ? $('article').first() :
    $('main').first().length ? $('main').first() :
    $('body').first();

  const cleanText = articleRoot.text().replace(/\s+/g, ' ').trim();
  const textWords = cleanText.split(/\s+/).filter(Boolean);
  const wordCount = textWords.length;

  const normalizedTitle = (title || '').replace(/\s+/g, ' ').trim();
  const fallbackTitle = normalizedTitle || cleanText.split(/[.!?]/)[0]?.trim() || 'Article';
  const description = (cleanText.slice(0, 220) || fallbackTitle).trim();

  const pageUrl = (() => {
    try {
      return siteUrl ? new URL(siteUrl).toString() : '';
    } catch (e) {
      return siteUrl || '';
    }
  })();

  const orgName = (() => {
    try {
      return siteUrl ? new URL(siteUrl).hostname : 'Publisher';
    } catch (e) {
      return 'Publisher';
    }
  })();

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: fallbackTitle,
    description,
    wordCount,
    author: {
      '@type': 'Organization',
      name: orgName
    },
    datePublished: new Date().toISOString(),
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': pageUrl
    }
  };

  // Add FAQ only when explicit FAQ-style Q/A exists in article content.
  const faqQuestions = [];
  articleRoot.find('h3, h4, strong').each((_, el) => {
    const q = $(el).text().replace(/\s+/g, ' ').trim();
    if (!q || q.length < 12 || q.length > 180) return;
    if (!/[?]$/.test(q) && !/^(what|how|why|when|where|who|can|does|is|are)\b/i.test(q)) return;
    const bad = /\b(home|about|menu|reviews|contact|privacy|terms|wordpress)\b/i.test(q);
    if (bad) return;
    faqQuestions.push(q);
  });
  const uniqueFaq = [...new Set(faqQuestions)].slice(0, 5);
  if (uniqueFaq.length >= 2) {
    schema['@type'] = ['Article', 'FAQPage'];
    schema.mainEntity = uniqueFaq.map(q => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'See the article section for the detailed answer.'
      }
    }));
  }

  return schema;
}

/**
 * Generates specific, actionable GEO recommendations based on the 5-pillar framework.
 */
function generateRecommendations(signals, brandRate, geoScore) {
  const recs = [];

  // ── 1. Technical Crawlability ──
  {
    let score = 0;
    if (!signals.has_meta_robots_block) score += 5;
    if (signals.alt_text_coverage >= 90 || signals.image_count === 0) score += 5;
    if (signals.has_llms_txt) score += 5;
    
    if (score < 15) {
      const issues = [];
      if (signals.has_meta_robots_block) issues.push('Remove robots meta noindex/nofollow — AI bots need access');
      if (signals.image_count > 0 && signals.alt_text_coverage < 90) issues.push(`Only ${signals.alt_text_coverage}% of images have descriptive alt text`);
      if (!signals.has_llms_txt) issues.push('No /llms.txt reference in page HTML — Gleo serves /llms.txt and adds a head link; re-scan after deploy');
      recs.push({
        priority: score <= 5 ? 'critical' : 'medium',
        area: 'Technical Crawlability',
        score, maxScore: 15,
        message: issues.join('. ') + '.'
      });
    }
  }

  // ── 2. Structured Data & Schema ──
  {
    let score = 0;
    if (signals.has_schema) score += 10;
    if (signals.has_faq_schema) score += 5;
    if (signals.has_org_schema) score += 5;
    
    if (score < 20) {
      const issues = [];
      if (!signals.has_schema) issues.push('Deploy JSON-LD schema markup so AI understands your content');
      if (!signals.has_faq_schema) issues.push('Add FAQPage schema — matches the Q&A format AI loves');
      if (!signals.has_org_schema) issues.push('Add Organization/LocalBusiness/Product schemas as needed');
      recs.push({
        priority: !signals.has_schema ? 'critical' : 'medium',
        area: 'Structured Data & Schema',
        score, maxScore: 20,
        message: issues.join('. ') + '.'
      });
    }
  }

  // ── 3. Content Quality ──
  {
    let score = 0;
    if (signals.word_count >= 2000) score += 10;
    else if (signals.word_count >= 1200) score += 7;
    else if (signals.word_count >= 600) score += 4;
    else if (signals.word_count > 0) score += 1;
    if (signals.has_direct_answer) score += 5;
    if (signals.has_tldr) score += 5;
    if (signals.has_conversational_queries) score += 3;
    if (signals.has_direct_answers) score += 2;
    if (signals.word_count >= 800 && signals.has_statistics) score += 3;
    if (signals.has_quotes) score += 2;
    score = Math.min(30, score);
    
    if (score < 30) {
      const issues = [];
      if (signals.word_count < 1200) issues.push(`Content is ${signals.word_count} words — aim for 1,200+ with depth`);
      if (!signals.has_direct_answer) issues.push('Put a 60-100 word direct answer at the very top (inverted pyramid)');
      if (!signals.has_tldr) issues.push('Add an opening “In brief” summary near the top of the article');
      if (!signals.has_conversational_queries) issues.push('Target long-tail conversational queries users ask AI');
      recs.push({
        priority: score <= 10 ? 'critical' : score <= 20 ? 'high' : 'medium',
        area: 'Content Quality',
        score, maxScore: 30,
        message: issues.join('. ') + '.'
      });
    }
  }

  // ── 4. Credibility ──
  {
    let score = 0;
    if (signals.stat_count >= 3) score += 5;
    else if (signals.stat_count >= 1) score += 3;
    if (signals.citation_count >= 3) score += 5;
    else if (signals.citation_count >= 1) score += 3;
    if (signals.has_quotes) score += 5;
    
    if (score < 15) {
      const issues = [];
      if (signals.stat_count < 3) issues.push('Add unique first-party statistics — AI craves data it hasn\'t seen');
      if (signals.citation_count < 3) issues.push('Add outbound links to authoritative sources for credibility');
      if (!signals.has_quotes) issues.push('Include expert quotes or real testimonials');
      recs.push({
        priority: score <= 5 ? 'high' : 'medium',
        area: 'Credibility',
        score, maxScore: 15,
        message: issues.join('. ') + '.'
      });
    }
  }

  // ── 5. AI-Specific Formatting ──
  {
    let score = 0;
    if (signals.heading_count >= 4) score += 5;
    else if (signals.heading_count >= 2) score += 3;
    else if (signals.has_headings) score += 1;
    if (signals.long_paragraphs === 0 && signals.paragraph_count > 0) score += 5;
    else if (signals.long_paragraphs <= 2) score += 3;
    if (signals.list_item_count >= 3) score += 4;
    else if (signals.has_lists) score += 2;
    if (signals.has_faq) score += 3;
    if (signals.has_table) score += 3;
    
    if (score < 20) {
      const issues = [];
      if (signals.heading_count < 4) issues.push(`Only ${signals.heading_count} headings — add H2s every ~3 paragraphs`);
      if (signals.long_paragraphs > 0) issues.push(`${signals.long_paragraphs} paragraph(s) exceed 80 words — shorten them`);
      if (!signals.has_lists) issues.push('Convert dense paragraphs into bulleted lists');
      if (!signals.has_faq) issues.push('Inject a contextual FAQ block near the end');
      if (!signals.has_table) issues.push('Add comparison tables — AI loves structured tabular data');
      recs.push({
        priority: score <= 8 ? 'high' : 'medium',
        area: 'AI-Specific Formatting',
        score, maxScore: 20,
        message: issues.join('. ') + '.'
      });
    }
  }

  return recs;
}

module.exports = { analyzePost, critiquePagePresentation };
