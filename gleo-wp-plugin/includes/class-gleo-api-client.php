<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Gleo_API_Client {

	private $api_base_url;

	public function __construct() {
		$base = defined( 'GLEO_NODE_API_URL' ) ? GLEO_NODE_API_URL : 'http://localhost:8765';
		$this->api_base_url = untrailingslashit( apply_filters( 'gleo_node_api_url', $base ) );
	}

	/**
	 * Strips Gutenberg block comments, shortcodes, and general metadata context
	 * to clean the post content before sending to the LLM backend.
	 */
	public function sanitize_content( $post_content ) {
		// Strip Gutenberg block comments: <!-- wp:... --> ... <!-- /wp:... -->
		$content = preg_replace( '/<!--(.|\s)*?-->/', '', $post_content );
		
		// Strip Shortcodes
		$content = strip_shortcodes( $content );
		
		return trim( $content );
	}

	/**
	 * Send a generic signed request to the Node API.
	 *
	 * @param string $endpoint API path (e.g. /v1/analyze/start).
	 * @param array  $payload  JSON-serializable body.
	 * @param int    $timeout  Seconds before HTTP timeout (Gemini polish needs longer).
	 */
	public function send_request( $endpoint, $payload, $timeout = 30 ) {
		$client_id  = get_option( 'gleo_client_id' );
		$secret_key = get_option( 'gleo_secret_key' );

		if ( empty( $client_id ) || empty( $secret_key ) ) {
			return new WP_Error( 'missing_credentials', 'Gleo Client ID or Secret Key is not configured.' );
		}

		$payload_json = wp_json_encode( $payload );

		// Sign payload with HMAC-SHA256
		$signature = hash_hmac( 'sha256', $payload_json, $secret_key );

		$args = array(
			'body'    => $payload_json,
			'headers' => array(
				'Content-Type'       => 'application/json',
				'X-Gleo-Client-Id'   => $client_id,
				'X-Gleo-Signature'   => $signature,
			),
			'timeout' => max( 5, (int) $timeout ),
		);

		$endpoint = '/' . ltrim( (string) $endpoint, '/' );
		$response = wp_remote_post( $this->api_base_url . $endpoint, $args );

        if ( is_wp_error( $response ) ) {
            return $response;
        }

        $status = wp_remote_retrieve_response_code( $response );
        if ( $status >= 400 ) {
            $body = json_decode( wp_remote_retrieve_body( $response ), true );
            $error_msg = isset($body['error']) ? $body['error'] : 'Unknown API error';
            return new WP_Error( 'api_error', 'Node API returned ' . $status . ': ' . $error_msg, array( 'status' => $status ) );
        }

        return $response;
	}
}
