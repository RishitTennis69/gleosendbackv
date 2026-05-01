<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Gleo_Analytics {

	public function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes() {
		register_rest_route( 'gleo/v1', '/analytics/history', array(
			'methods'             => 'GET',
			'callback'            => array( $this, 'get_history' ),
			'permission_callback' => function() {
				return current_user_can( 'manage_options' );
			},
		) );
	}

	/**
	 * Return historical Brand Inclusion Rate + GEO Score data for the graph.
	 * Groups by scan date and returns averaged values per day.
	 */
	public function get_history( $request ) {
		global $wpdb;
		$table = $wpdb->prefix . 'gleo_scan_history';

		$post_id = $request->get_param( 'post_id' );
		
		$where = '';
		$prepare_args = array();
		if ( ! empty( $post_id ) ) {
			$where = "WHERE post_id = %d";
			$prepare_args[] = (int) $post_id;
		}

		$query = "SELECT 
				DATE(scanned_at) as scan_date,
				ROUND(AVG(brand_inclusion_rate), 1) as avg_brand_rate,
				ROUND(AVG(geo_score), 1) as avg_geo_score,
				COUNT(*) as posts_scanned
			FROM {$table}
			{$where}
			GROUP BY DATE(scanned_at)
			ORDER BY scan_date ASC
			LIMIT 30";
			
		if ( ! empty( $prepare_args ) ) {
			$query = $wpdb->prepare( $query, $prepare_args );
		}

		$rows = $wpdb->get_results( $query );

		return rest_ensure_response( array(
			'history' => $rows,
		) );
	}

	/**
	 * Called by the webhook handler after a scan completes.
	 * Logs the score data to the history table.
	 */
	public static function log_scan( $post_id, $geo_score, $brand_rate ) {
		global $wpdb;
		$table = $wpdb->prefix . 'gleo_scan_history';

		$wpdb->insert(
			$table,
			array(
				'post_id'              => $post_id,
				'geo_score'            => (int) $geo_score,
				'brand_inclusion_rate' => (int) $brand_rate,
			),
			array( '%d', '%d', '%d' )
		);
	}
}

new Gleo_Analytics();
