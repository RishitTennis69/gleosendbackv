<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Gleo_Batch_Scanner {

	/**
	 * Extract article-focused HTML from rendered page so analysis avoids nav/footer/theme chrome.
	 *
	 * @param string $full_html Full rendered page HTML.
	 * @return string
	 */
	private function extract_focus_html_from_rendered_page( $full_html ) {
		if ( ! is_string( $full_html ) || '' === trim( $full_html ) ) {
			return '';
		}
		if ( ! class_exists( 'DOMDocument' ) ) {
			return '';
		}
		$dom = new DOMDocument();
		libxml_use_internal_errors( true );
		$ok = $dom->loadHTML( '<?xml encoding="utf-8" ?>' . $full_html, LIBXML_NOWARNING | LIBXML_NOERROR );
		libxml_clear_errors();
		libxml_use_internal_errors( false );
		if ( ! $ok ) {
			return '';
		}
		$xpath = new DOMXPath( $dom );
		$content_node = null;
		foreach ( array(
			"//*[contains(concat(' ', normalize-space(@class), ' '), ' entry-content ')]",
			"//*[contains(concat(' ', normalize-space(@class), ' '), ' wp-block-post-content ')]",
			'//article',
			'//main',
			'//body',
		) as $query ) {
			$nodes = $xpath->query( $query );
			if ( $nodes instanceof DOMNodeList && $nodes->length > 0 ) {
				$content_node = $nodes->item( 0 );
				break;
			}
		}
		if ( ! $content_node ) {
			return '';
		}
		$head_snippets = '';
		foreach ( array(
			'//head/meta[@name="robots"]',
			'//head/script[@type="application/ld+json"]',
			'//head/link[@rel="alternate" and contains(@href, "/llms.txt")]',
		) as $query ) {
			$nodes = $xpath->query( $query );
			if ( $nodes instanceof DOMNodeList && $nodes->length > 0 ) {
				foreach ( $nodes as $node ) {
					$head_snippets .= $dom->saveHTML( $node );
				}
			}
		}
		$body_html = $dom->saveHTML( $content_node );
		if ( ! is_string( $body_html ) || '' === trim( $body_html ) ) {
			return '';
		}
		$body_html = preg_replace( '/<header[\s\S]*?<\/header>/i', '', $body_html );
		$body_html = preg_replace( '/<nav[\s\S]*?<\/nav>/i', '', $body_html );
		$body_html = preg_replace( '/<footer[\s\S]*?<\/footer>/i', '', $body_html );
		return "<!doctype html><html><head>{$head_snippets}</head><body>{$body_html}</body></html>";
	}

	public function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes() {
		$namespace = 'gleo/v1';

		register_rest_route( $namespace, '/scan/start', array(
			'methods'             => 'POST',
			'callback'            => array( $this, 'start_scan' ),
			'permission_callback' => function() {
				return current_user_can( 'manage_options' );
			},
		) );

		register_rest_route( $namespace, '/scan/webhook', array(
			'methods'             => 'POST',
			'callback'            => array( $this, 'handle_webhook' ),
			'permission_callback' => '__return_true', // webhook from node
		) );

		register_rest_route( $namespace, '/scan/status', array(
			'methods'             => 'GET',
			'callback'            => array( $this, 'get_status' ),
			'permission_callback' => function() {
				return current_user_can( 'manage_options' );
			},
		) );
	}

	public function start_scan( $request ) {
		$params = $request->get_json_params();
		$post_ids = isset( $params['post_ids'] ) ? $params['post_ids'] : array();

		if ( empty( $post_ids ) || ! is_array( $post_ids ) ) {
			return new WP_Error( 'no_posts', 'No posts selected.', array( 'status' => 400 ) );
		}

		// get selected published posts
		$posts = get_posts( array(
			'post__in'    => $post_ids,
			'numberposts' => -1,
			'post_status' => 'publish',
		) );

		if ( empty( $posts ) ) {
			return new WP_Error( 'no_posts', 'No valid published posts found.', array( 'status' => 404 ) );
		}

		global $wpdb;
		$table_name = $wpdb->prefix . 'gleo_scans';

        // Clear ALL old scan data before a fresh run (removes stale results from previous formats)
        $wpdb->query( "TRUNCATE TABLE $table_name" );

		$payload = array(
			'batch_id' => uniqid('batch_'),
			'webhook'  => rest_url( 'gleo/v1/scan/webhook' ),
			'site_url' => get_site_url(),
			'posts'    => array(),
		);

		$api_client = new Gleo_API_Client();

		foreach ( $posts as $post ) {
			// Fetch the live rendered HTML of the post
			$permalink = get_permalink( $post->ID );
			$response = null;

			if ( $permalink ) {
				$response = wp_remote_get( $permalink );
			}
			
			$html_content = '';
			if ( $response && ! is_wp_error( $response ) && wp_remote_retrieve_response_code( $response ) === 200 ) {
				$full_html = wp_remote_retrieve_body( $response );
				$focused_html = $this->extract_focus_html_from_rendered_page( $full_html );
				$html_content = '' !== $focused_html ? $focused_html : $full_html;
			} else {
				// Fallback to basic content if the live fetch fails for some reason
				$html_content = $api_client->sanitize_content( $post->post_content );
				
				// Inject schema proxy string so cheerio still identifies it if fallback was triggered
				$global_override = get_option( 'gleo_override_schema', false );
				$post_override   = get_post_meta( $post->ID, '_gleo_schema_override', true );
				if ( $global_override || $post_override ) {
					$html_content .= "\n<script type=\"application/ld+json\"></script>";
				}
			}

			$payload['posts'][] = array(
				'id'      => $post->ID,
				'title'   => $post->post_title,
				'content' => $html_content, // Now sending the full HTML
			);

			// create/update db entry
			$wpdb->replace( 
				$table_name,
				array(
					'post_id'     => $post->ID,
					'scan_status' => 'pending',
				),
				array( '%d', '%s' )
			);
		}

		// Send request to new endpoint
		$response = $api_client->send_request( '/v1/analyze/start', $payload );

		if ( is_wp_error( $response ) ) {
            // Cleanup database immediately to prevent indefinite polling locking up the UI
            $wpdb->query( "DELETE FROM $table_name WHERE scan_status = 'pending'" );
			return $response;
		}

		return rest_ensure_response( array( 'success' => true, 'message' => 'Scan started.', 'batch_id' => $payload['batch_id'] ) );
	}

	public function handle_webhook( $request ) {
		// Verify signature if needed, here we'll just check if basic is valid
		$params = $request->get_json_params();

        // Node sends back an array of post results
        if ( isset( $params['results'] ) && is_array( $params['results'] ) ) {
            global $wpdb;
            $table_name = $wpdb->prefix . 'gleo_scans';

            foreach ( $params['results'] as $result ) {
                $wpdb->update(
                    $table_name,
                    array(
                        'scan_status' => 'completed',
                        'scan_result' => wp_json_encode( $result['data'] ),
                    ),
                    array( 'post_id' => $result['id'] ),
                    array( '%s', '%s' ),
                    array( '%d' )
                );

                // Log to history for the analytics graph
                $geo_score  = isset( $result['data']['geo_score'] ) ? $result['data']['geo_score'] : 0;
                $brand_rate = isset( $result['data']['brand_inclusion_rate'] ) ? $result['data']['brand_inclusion_rate'] : 0;
                Gleo_Analytics::log_scan( $result['id'], $geo_score, $brand_rate );
            }
        }

		return rest_ensure_response( array( 'success' => true ) );
	}

	public function get_status( $request ) {
		global $wpdb;
		$table_name = $wpdb->prefix . 'gleo_scans';

        // Auto-heal: If a batch has been stuck in 'pending' for over 10 minutes, clear it out.
        // (Generous window — each post can take 10–60s for Tavily + Gemini analysis.)
        $wpdb->query( "DELETE FROM $table_name WHERE scan_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)" );

		$pending_count   = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $table_name WHERE scan_status = 'pending'" );
		$completed_count = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $table_name WHERE scan_status = 'completed'" );

		$total = $pending_count + $completed_count;

		// Always surface completed results — even mid-scan — so the UI can stream them in.
		$results = array();
		if ( $completed_count > 0 ) {
			$results_rows = $wpdb->get_results( "SELECT post_id, scan_result FROM $table_name WHERE scan_status = 'completed'" );
			foreach ( $results_rows as $row ) {
				$pid  = (int) $row->post_id;
				$link = get_permalink( $pid );
				if ( ! $link ) {
					$link = home_url( '/?p=' . $pid );
				}
				$results[] = array(
					'post_id'     => $pid,
					'preview_url' => add_query_arg( 'gleo_iframe', '1', $link ),
					'result'      => json_decode( $row->scan_result, true ),
				);
			}
		}

		$progress = $total > 0 ? ( $completed_count / $total ) * 100 : 0;

		return rest_ensure_response( array(
			'is_scanning' => $pending_count > 0,
			'progress'    => $progress,
			'total'       => $total,
			'completed'   => $completed_count,
			'results'     => $results,
		) );
	}
}

new Gleo_Batch_Scanner();
