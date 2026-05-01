<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class Gleo_Tracking {

    public function __construct() {
        add_action( 'template_redirect', array( $this, 'detect_ai_bots' ) );
    }

    private function get_api_base() {
        $base = defined( 'GLEO_NODE_API_URL' ) ? GLEO_NODE_API_URL : 'http://localhost:8765';
        return apply_filters( 'gleo_node_api_url', $base );
    }

    public function detect_ai_bots() {
        $user_agent = isset( $_SERVER['HTTP_USER_AGENT'] )
            ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) )
            : '';
        if ( empty( $user_agent ) ) return;

        $bots = array(
            'GPTBot'          => 'OpenAI GPTBot',
            'ChatGPT-User'    => 'OpenAI ChatGPT',
            'ClaudeBot'       => 'Anthropic Claude',
            'Google-Extended' => 'Google Gemini (Extended)',
            'PerplexityBot'   => 'Perplexity AI',
            'OAI-SearchBot'   => 'OpenAI SearchBot',
            'cohere-ai'       => 'Cohere AI',
        );

        foreach ( $bots as $key => $name ) {
            if ( stripos( $user_agent, $key ) !== false ) {
                $this->log_bot_hit( $name );
                break;
            }
        }
    }

    private function log_bot_hit( $bot_name ) {
        $site_id = wp_parse_url( get_site_url(), PHP_URL_HOST );
        $path    = isset( $_SERVER['REQUEST_URI'] )
            ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) )
            : '';

        $api_url = trailingslashit( $this->get_api_base() ) . 'v1/analytics/bot-hit';

        wp_remote_post( $api_url, array(
            'blocking'    => false,
            'timeout'     => 1,
            'redirection' => 0,
            'headers'     => array( 'Content-Type' => 'application/json' ),
            'body'        => wp_json_encode( array(
                'site_id'      => $site_id,
                'bot_name'     => $bot_name,
                'request_path' => $path,
                'status_code'  => http_response_code() ?: 200,
            ) ),
        ) );
    }
}

new Gleo_Tracking();
