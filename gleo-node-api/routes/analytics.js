const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// In-memory SOV cache (survives Supabase outages)
const sovCache = {};

// POST /v1/analytics/bot-hit
router.post('/bot-hit', async (req, res) => {
  const { site_id, bot_name, request_path, status_code } = req.body;
  if (!site_id || !bot_name) return res.status(400).json({ error: 'Missing site_id or bot_name' });

  try {
    await supabase.from('bot_traffic_logs').insert([{
      site_id, bot_name, request_path: request_path || '/', status_code: status_code || 200, timestamp: new Date().toISOString()
    }]);
  } catch (e) { /* best effort */ }

  res.json({ success: true });
});

// GET /v1/analytics/sov
router.get('/sov', async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'Missing site_id' });

  // Serve from in-memory cache first
  if (sovCache[site_id]) {
    return res.json({ data: sovCache[site_id] });
  }

  // Otherwise try Supabase
  try {
    const { data, error } = await supabase
      .from('visibility_snapshots')
      .select('*')
      .eq('site_id', site_id)
      .order('timestamp', { ascending: false })
      .limit(1);

    if (!error && data && data.length > 0) {
      sovCache[site_id] = data[0].raw_response;
      return res.json({ data: data[0].raw_response });
    }
  } catch (e) {
    console.warn('[SOV GET] Supabase unreachable, serving from cache');
  }

  res.json({ data: null });
});

// GET /v1/analytics/bot-feed
router.get('/bot-feed', async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'Missing site_id' });

  try {
    const { data, error } = await supabase
      .from('bot_traffic_logs')
      .select('*')
      .eq('site_id', site_id)
      .order('timestamp', { ascending: false })
      .limit(20);

    if (!error) return res.json({ data: data || [] });
  } catch (e) { /* fall through */ }

  res.json({ data: [] });
});

// POST /v1/analytics/sov/refresh
router.post('/sov/refresh', async (req, res) => {
  const { site_id, queries } = req.body;
  if (!site_id) return res.status(400).json({ error: 'Missing site_id' });

  const { runSOVSimulation } = require('../lib/sov-simulator');

  try {
    const report = await runSOVSimulation(site_id, queries);
    // Cache immediately so GET works even if Supabase is down
    sovCache[site_id] = report;
    res.json({ success: true, data: report, message: 'AI Visibility analysis complete.' });
  } catch (err) {
    console.error('[SOV Refresh] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
