<?php
/**
 * Plugin Name: Playground Proxy URL
 * Description: Points the site at a tunnel/https proxy URL while one is active. Part of @krokedil/wp-playground-tools; staged into .playground/mu-plugins/ and symlinked into mu-plugins/.
 *
 * The host tool writes the public URL to .playground/proxy-url.txt when a
 * proxy (ngrok tunnel or local https proxy) is running, and deletes it on
 * exit. While the file exists this mu-plugin:
 *
 *   - filters home/siteurl to the proxy URL (no DB writes, so warm boots and
 *     proxy-less boots are untouched);
 *   - marks the request as HTTPS when the proxy says so via X-Forwarded-Proto
 *     (trusted only from loopback — the proxy/tunnel agent connects locally),
 *     so is_ssl() is true, auth cookies are secure and no mixed content is
 *     emitted;
 *   - webhook/callback URLs built from home_url() automatically become proxy
 *     URLs, which is the point for payment-provider callbacks.
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Read the active proxy URL, if any. __DIR__ resolves through the mu-plugins
 * symlink to .playground/mu-plugins/, so the URL file is one level up.
 *
 * @return string Proxy URL without trailing slash, or '' when none is active.
 */
function krokedil_pg_proxy_url() {
	static $url = null;
	if ( null !== $url ) {
		return $url;
	}
	$file = dirname( __DIR__ ) . '/proxy-url.txt';
	$raw  = is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : '';
	$url  = preg_match( '#^https?://#', $raw ) ? untrailingslashit( $raw ) : '';
	return $url;
}

/**
 * Whether the request came through the local proxy claiming HTTPS.
 *
 * @return bool True for a loopback request with X-Forwarded-Proto: https.
 */
function krokedil_pg_proxy_is_https_request() {
	$remote = isset( $_SERVER['REMOTE_ADDR'] ) ? $_SERVER['REMOTE_ADDR'] : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	$proto  = isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	return in_array( $remote, array( '127.0.0.1', '::1' ), true ) && 'https' === $proto;
}

if ( '' !== krokedil_pg_proxy_url() ) {
	foreach ( array( 'option_home', 'option_siteurl' ) as $filter ) {
		add_filter(
			$filter,
			function () {
				return krokedil_pg_proxy_url();
			},
			1000
		);
	}

	if ( krokedil_pg_proxy_is_https_request() ) {
		$_SERVER['HTTPS'] = 'on';
	}
}
