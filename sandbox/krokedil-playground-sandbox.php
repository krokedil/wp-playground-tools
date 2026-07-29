<?php
/**
 * Plugin Name: Krokedil Playground Sandbox
 * Description: Dogfooding fixture for @krokedil/wp-playground-tools — surfaces transport diagnostics so plain-http, --https and --tunnel runs can be verified at a glance.
 * Version: 1.0.0
 *
 * This plugin exists only in this repo's sandbox/ directory; it is mounted and
 * activated by the sandbox:* scripts and is never shipped to consumers.
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Collect the transport diagnostics shown in the dashboard widget and the
 * REST ping response.
 *
 * @return array<string, string> Label => value.
 */
function krokedil_pg_sandbox_diagnostics() {
	$header = function ( $key ) {
		return isset( $_SERVER[ $key ] ) ? sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ) : '(not set)';
	};
	// Provided by the playground-proxy-url.php mu-plugin while a proxy runs.
	$proxy_url = function_exists( 'krokedil_pg_proxy_url' ) ? krokedil_pg_proxy_url() : '';

	return array(
		'home_url()'        => home_url( '/' ),
		'site_url()'        => site_url( '/' ),
		'rest_url(ping)'    => rest_url( 'krokedil-sandbox/v1/ping' ),
		'is_ssl()'          => is_ssl() ? 'true' : 'false',
		'proxy-url.txt'     => '' !== $proxy_url ? $proxy_url : '(no proxy active)',
		'X-Forwarded-Proto' => $header( 'HTTP_X_FORWARDED_PROTO' ),
		'X-Forwarded-Host'  => $header( 'HTTP_X_FORWARDED_HOST' ),
		'REMOTE_ADDR'       => $header( 'REMOTE_ADDR' ),
	);
}

add_action(
	'wp_dashboard_setup',
	function () {
		wp_add_dashboard_widget(
			'krokedil_pg_sandbox',
			'Playground Sandbox — transport diagnostics',
			'krokedil_pg_sandbox_render_widget'
		);
	}
);

/**
 * Render the diagnostics dashboard widget.
 *
 * @return void
 */
function krokedil_pg_sandbox_render_widget() {
	echo '<table class="widefat striped">';
	foreach ( krokedil_pg_sandbox_diagnostics() as $label => $value ) {
		printf(
			'<tr><td><code>%s</code></td><td>%s</td></tr>',
			esc_html( $label ),
			esc_html( $value )
		);
	}
	echo '</table>';
	echo '<p class="description">Behind <code>--https</code> / <code>--tunnel</code>, home_url() must show the proxy origin and is_ssl() must be true.</p>';
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'krokedil-sandbox/v1',
			'/ping',
			array(
				'methods'             => 'GET',
				// Public on purpose: a dev-only sandbox echoing transport
				// facts (no user data) — the target for webhook-style calls
				// through the ngrok tunnel.
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return rest_ensure_response( krokedil_pg_sandbox_diagnostics() );
				},
			)
		);
	}
);
