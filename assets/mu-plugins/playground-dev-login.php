<?php
/**
 * Plugin Name: Playground Dev Login
 * Description: Auto-submits the wp-login.php form as admin (development blueprint only). Part of @krokedil/wp-playground-tools; staged into .playground/mu-plugins/ and symlinked into mu-plugins/.
 *
 * Playground's own auto-login (blueprint `login: true`) is single-shot per
 * client: the first HTTP request consumes it, so a curl health check or a
 * tool's probe eats the login and the developer's first real visit lands on
 * the wp-login form — and after `--fresh` the wiped sessions demand a manual
 * login again. This mu-plugin removes the form from the dev loop instead:
 * any plain GET of wp-login.php while logged out signs in as `admin` and
 * follows redirect_to. It never triggers outside wp-login.php, so the
 * storefront stays guest-browsable (guest checkout testing keeps working).
 *
 * Deliberate login flows keep the form: POST submissions (signing in as a
 * different user), any ?action=… (logout, lostpassword, rp — or an explicit
 * wp-login.php?action=login to summon the form), the ?loggedout screen after
 * a logout, and ?interim-login re-auth modals.
 *
 * Caveat: with --tunnel the dev site is publicly reachable, and this makes
 * wp-login.php an instant admin door for anyone holding the tunnel URL.
 * Dev sites are throwaway by design — keep real data and production keys out
 * of them (see the secrets warning in the README).
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Sign a plain GET of the login form in as admin and redirect onwards.
 */
function krokedil_pg_dev_login() {
	// CLI runs (wp-cli through Playground) have no request; only intercept
	// plain GETs so credential POSTs for other users go through untouched.
	if ( empty( $_SERVER['REQUEST_URI'] ) || 'GET' !== ( isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : '' ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		return;
	}
	$path = (string) wp_parse_url( (string) $_SERVER['REQUEST_URI'], PHP_URL_PATH ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	if ( 'wp-login.php' !== basename( $path ) ) {
		return;
	}
	// Explicit flows that must render the form.
	if ( isset( $_GET['action'] ) || isset( $_GET['loggedout'] ) || isset( $_GET['interim-login'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
		return;
	}
	if ( is_user_logged_in() ) {
		return;
	}
	$user = get_user_by( 'login', 'admin' ); // The Playground CLI default admin.
	if ( ! $user || headers_sent() ) {
		return;
	}

	wp_set_current_user( $user->ID, $user->user_login );
	wp_set_auth_cookie( $user->ID );
	do_action( 'wp_login', $user->user_login, $user );

	$redirect = isset( $_GET['redirect_to'] ) ? wp_unslash( $_GET['redirect_to'] ) : admin_url(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput, WordPress.Security.NonceVerification
	wp_safe_redirect( wp_validate_redirect( $redirect, admin_url() ) );
	exit;
}
add_action( 'init', 'krokedil_pg_dev_login', 5 );
