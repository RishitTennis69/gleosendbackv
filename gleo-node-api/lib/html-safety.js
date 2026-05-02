/**
 * Safety checks for WordPress block markup after Gemini (or any) HTML revision.
 */

function countWpBlockMarkers(html) {
  if (!html || typeof html !== 'string') {
    return 0;
  }
  const m = html.match(/<!--\s*wp:/g);
  return m ? m.length : 0;
}

/**
 * @param {string} beforeHtml
 * @param {string} afterHtml
 * @param {{ minRatio?: number, minAfterChars?: number }} [opts]
 * @returns {{ ok: boolean, reason?: string, before?: number, after?: number }}
 */
function assertSafeWpRevision(beforeHtml, afterHtml, opts = {}) {
  const minRatio = typeof opts.minRatio === 'number' ? opts.minRatio : 0.88;
  const minAfterChars = typeof opts.minAfterChars === 'number' ? opts.minAfterChars : 200;

  const before = String(beforeHtml || '');
  const after = String(afterHtml || '');

  if (!after.trim()) {
    return { ok: false, reason: 'empty_output' };
  }

  if (after.length < minAfterChars && before.length >= minAfterChars) {
    return { ok: false, reason: 'output_too_short' };
  }

  const b = countWpBlockMarkers(before);
  const a = countWpBlockMarkers(after);

  if (b > 0) {
    const floor = Math.max(1, Math.floor(b * minRatio));
    if (a < floor) {
      return { ok: false, reason: 'wp_block_marker_drop', before: b, after: a };
    }
  }

  return { ok: true, before: b, after: a };
}

module.exports = { countWpBlockMarkers, assertSafeWpRevision };
