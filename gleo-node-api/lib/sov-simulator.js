const cron = require('node-cron');
const axios = require('axios');
const supabase = require('./supabase');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * Runs a real AI Share-of-Voice analysis using Tavily.
 * For each query (post title), it searches Tavily and counts which domains
 * appear in the AI-generated results. The site that appears most often
 * has the highest "share of voice."
 *
 * @param {string} siteId - The site hostname (e.g., "mysite.com")
 * @param {string[]} queries - Post titles or keyword phrases to search
 */
async function runSOVSimulation(siteId, queries = []) {
  console.log(`[SOV] Running real Tavily analysis for ${siteId} with ${queries.length} queries...`);

  if (!queries.length) {
    console.warn('[SOV] No queries provided — using site name as fallback');
    queries = [siteId];
  }

  // Cap at 5 queries to avoid burning Tavily credits
  const searchQueries = queries.slice(0, 5);

  // Domain appearance counter across all queries
  const domainHits = {};
  let totalResults = 0;
  let yourSiteHits = 0;
  const siteDomain = siteId.replace('www.', '').toLowerCase();

  for (const query of searchQueries) {
    try {
      console.log(`  [SOV] Searching: "${query}"`);
      const response = await axios.post(TAVILY_SEARCH_URL, {
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'advanced',
        include_answer: true,
        include_raw_content: false,
        max_results: 10
      });

      const results = response.data.results || [];
      totalResults += results.length;

      for (const result of results) {
        try {
          const url = new URL(result.url);
          const domain = url.hostname.replace('www.', '').toLowerCase();

          // Track if it's our site
          if (domain === siteDomain || domain.includes(siteDomain) || siteDomain.includes(domain)) {
            yourSiteHits++;
          }

          // Count all domains
          if (!domainHits[domain]) domainHits[domain] = 0;
          domainHits[domain]++;
        } catch (e) { /* skip invalid URLs */ }
      }
    } catch (err) {
      console.error(`  [SOV] Tavily search failed for "${query}":`, err.message);
    }
  }

  if (totalResults === 0) {
    console.warn('[SOV] No results from Tavily — returning empty report');
    return {
      brand_name: siteId,
      queries_searched: searchQueries.length,
      total_results: 0,
      market_share: [{ name: siteId, percentage: 0 }]
    };
  }

  // Sort domains by hit count
  const sorted = Object.entries(domainHits)
    .sort((a, b) => b[1] - a[1]);

  // Calculate percentages
  const topCompetitors = sorted.slice(0, 8); // top 8 domains
  const shares = topCompetitors.map(([domain, hits]) => ({
    name: domain,
    percentage: Math.round((hits / totalResults) * 100),
    hits
  }));

  // Make sure "Your Site" is identifiable
  const yourEntry = shares.find(s =>
    s.name === siteDomain ||
    s.name.includes(siteDomain) ||
    siteDomain.includes(s.name)
  );

  // If site wasn't in results at all, add it at 0%
  if (!yourEntry) {
    shares.unshift({ name: siteId, percentage: 0, hits: 0, isYou: true });
  } else {
    yourEntry.name = siteId; // rename to friendly name
    yourEntry.isYou = true;
  }

  // Ensure percentages are reasonable (top entries)
  // Only show top 6 to keep UI clean
  const finalShares = shares.slice(0, 6);

  const report = {
    brand_name: siteId,
    queries_searched: searchQueries.length,
    total_results: totalResults,
    market_share: finalShares
  };

  // Best-effort Supabase persist
  try {
    await supabase.from('visibility_snapshots').insert([{
      site_id: siteId, model_name: 'tavily-sov', raw_response: report
    }]);
  } catch (dbErr) {
    console.warn('[SOV] Supabase save failed (non-critical):', dbErr.message);
  }

  console.log(`[SOV] Analysis complete for ${siteId}: ${totalResults} results across ${searchQueries.length} queries`);
  return report;
}

// Weekly job (Sundays at midnight)
function initSOVCron() {
  cron.schedule('0 0 * * 0', async () => {
    console.log('[SOV] Starting weekly global simulation...');
    try {
      const { data: subs } = await supabase.from('subscriptions').select('site_id');
      if (subs) {
        for (const sub of subs) {
          await runSOVSimulation(sub.site_id);
        }
      }
    } catch (e) { console.warn('[SOV] Cron skipped:', e.message); }
  });
  console.log('[SOV] Weekly analysis cron initialized.');
}

module.exports = { initSOVCron, runSOVSimulation };
