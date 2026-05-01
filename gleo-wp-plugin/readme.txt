=== Gleo ===
Contributors: kgthekg
Tags: ai, seo, geo, schema, content optimization
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Gleo edits your site with proven GEO techniques to increase AI mentions.

== Description ==

Gleo helps publishers optimize WordPress posts for Generative Engine Optimization (GEO), so content is easier for AI assistants and answer engines to parse, cite, and summarize.

It provides post-level scans, issue scoring, and one-click fixes for structure, readability, FAQ, schema, key takeaways, and other GEO-focused improvements.

### Core features

* Scan published posts for GEO signals and get a category-by-category score.
* Apply one-click improvements for:
  * Structured data and schema enhancement
  * Heading structure and readability
  * FAQ blocks and comparison tables
  * Key takeaways and opening summary
  * Image alt text improvements
* Preview changes before and after applying updates.
* Track GEO-related visibility trends in the admin dashboard.

### How it works

Gleo runs inside WordPress and can optionally connect to a companion analysis API if configured. API credentials are stored in WordPress options and are not exposed on the public frontend.

== Installation ==

1. Upload the `gleo` plugin folder to `/wp-content/plugins/`, or install from the WordPress admin Plugins screen.
2. Activate the plugin through the **Plugins** screen.
3. Go to **Gleo** in wp-admin.
4. Configure API credentials in **Settings** (if you are using the companion API).
5. Run your first scan from the **Scan** tab.

== Frequently Asked Questions ==

= Does Gleo require an external API? =

Some advanced analysis features use a companion API endpoint. You can configure this in settings or via `GLEO_NODE_API_URL`.

= Will this overwrite all my content automatically? =

No. You review scan output and trigger fixes manually (or by category) in the admin UI.

= Are API keys exposed publicly? =

No. Keys are stored as WordPress options and used server-side for signed requests.

== Changelog ==

= 1.0.1 =
* Production hardening for public release.
* Added WordPress.org metadata and packaging readiness.
* Updated plugin header and versioning.

= 1.0.0 =
* Initial public feature set:
* GEO scans, scoring, AI-aware formatting and schema actions.
* Preview workflow and analytics dashboard.

