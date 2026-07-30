<?php
/**
 * Plugin Name: Playground Dev Login
 * Description: Auto-submits the wp-login.php form as admin (development blueprint only). Part of @krokedil/wp-playground-tools; staged into .playground/mu-plugins/ and symlinked into mu-plugins/.
 *
 * Playground's own auto-login (blueprint `login: true`) is per client: every
 * HTTP request without its marker cookie gets a full admin login plus a 302
 * back to itself, so a cookie-less curl probe or health check redirect-loops
 * forever while writing a session row per attempt. The tooling therefore
 * doesn't enable it in development mode; this mu-plugin removes the login
 * form from the dev loop instead: any plain GET of wp-login.php while logged
 * out signs in as `admin` and follows redirect_to. It never triggers outside
 * wp-login.php, so the storefront stays guest-browsable.
 *
 * Deliberate login flows keep the form: POST submissions (signing in as a
 * different user), any ?action=… (logout, lostpassword, rp — or an explicit
 * wp-login.php?action=login to summon the form), the ?loggedout screen after
 * a logout, and ?interim-login re-auth modals.
 *
 * Guest mode — `?krokedil-guest=1` on any local URL (or "Browse as guest" in
 * the admin bar): logging out is not enough to stay logged out, because
 * WordPress renders front-end login links as plain wp-login.php?redirect_to=…
 * GETs, which this mu-plugin treats as "log me in" — so one stray click on a
 * comment form or the Meta widget ends a guest test and bounces you into
 * wp-admin. Guest mode logs you out and sets a cookie that stands this
 * mu-plugin (and Playground's own auto-login) down for 12 hours, so the
 * browser stays a visitor until `?krokedil-guest=0`. It is per browser: a
 * second profile stays admin. Entering it clears the cart along with the
 * session, which is what a clean guest checkout run wants.
 *
 * Local-only by design: auto-login requires a loopback Host (localhost,
 * 127.0.0.1, ::1, *.localhost) — direct http and the mkcert https proxy
 * qualify, but requests arriving through an ngrok tunnel carry the tunnel
 * domain and always get the normal form. Otherwise anyone holding the tunnel
 * URL would be one GET away from admin. Dev sites are throwaway by design —
 * keep real data and production keys out of them regardless (see the secrets
 * warning in the README).
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Cookie that marks this browser as a guest (see the guest-mode notes above). */
const KROKEDIL_PG_GUEST_COOKIE = 'krokedil_pg_guest';

/** Query parameter that turns guest mode on (`1`) or off (`0`). */
const KROKEDIL_PG_GUEST_PARAM = 'krokedil-guest';

// Disarm Playground's own auto-login for guest browsers. It authenticates on
// this cookie marker with no password check and runs on `init` from an
// internal mu-plugin loaded on muplugins_loaded — later than this file — so
// setting the marker here is enough, and it must happen at load time rather
// than in a hook. Same technique as playground-tunnel-guard.php.
if ( isset( $_COOKIE[ KROKEDIL_PG_GUEST_COOKIE ] ) ) {
	$_COOKIE['playground_auto_login_already_happened'] = '1';
	unset( $_GET['playground_force_auto_login_as_user'] );
}

/**
 * Whether the request was addressed to the machine itself.
 *
 * Hostnames are the primary signal: a tunnel agent connects from loopback,
 * so REMOTE_ADDR alone can't tell tunnel traffic apart — but ngrok delivers
 * requests with the tunnel domain as Host (its edge routes by Host, so a
 * spoofed localhost Host never reaches the tunnel), while the local https
 * proxy forwards with Host/X-Forwarded-Host: localhost:<port>. A loopback
 * REMOTE_ADDR is additionally required (when the SAPI provides one) so a
 * LAN/bridge client that spoofs a localhost Host still gets the form —
 * same trust rule as krokedil_pg_proxy_is_https_request().
 *
 * @return bool True when the peer (if known) and every host name are loopback.
 */
function krokedil_pg_dev_login_is_local() {
	if (
		isset( $_SERVER['REMOTE_ADDR'] )
		&& ! in_array( $_SERVER['REMOTE_ADDR'], array( '127.0.0.1', '::1' ), true ) // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	) {
		return false;
	}
	foreach ( array( 'HTTP_HOST', 'HTTP_X_FORWARDED_HOST' ) as $key ) {
		if ( ! isset( $_SERVER[ $key ] ) ) {
			continue;
		}
		$host = strtolower( trim( (string) $_SERVER[ $key ] ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		// Strip the port: bracketed IPv6 first, then host:port.
		if ( preg_match( '/^\[([^\]]+)\]/', $host, $m ) ) {
			$host = $m[1];
		} else {
			$host = preg_replace( '/:\d+$/', '', $host );
		}
		$local = in_array( $host, array( 'localhost', '127.0.0.1', '::1' ), true )
			|| '.localhost' === substr( $host, -10 );
		if ( ! $local ) {
			return false;
		}
	}
	return isset( $_SERVER['HTTP_HOST'] );
}

/**
 * Enter or leave guest mode when ?krokedil-guest=… is present.
 *
 * Runs before krokedil_pg_dev_login() and always redirects to the same URL
 * without the parameter, so it never sticks in the address bar, in links the
 * developer copies, or in a redirect_to value.
 */
function krokedil_pg_dev_login_guest_toggle() {
	if ( 'GET' !== ( isset( $_SERVER['REQUEST_METHOD'] ) ? $_SERVER['REQUEST_METHOD'] : '' ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		return;
	}
	if ( ! isset( $_GET[ KROKEDIL_PG_GUEST_PARAM ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
		return;
	}
	// Local only, like the auto-login itself: nobody holding a tunnel URL gets
	// to change how that site authenticates (there, playground-tunnel-guard.php
	// owns login behaviour).
	if ( ! krokedil_pg_dev_login_is_local() || headers_sent() ) {
		return;
	}

	$raw     = strtolower( trim( (string) wp_unslash( $_GET[ KROKEDIL_PG_GUEST_PARAM ] ) ) ); // phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput
	$wants   = in_array( $raw, array( '1', 'true', 'yes', 'on', '' ), true );
	$path    = COOKIEPATH ? COOKIEPATH : '/';
	// 12 hours: covers a working day, and expires overnight so a forgotten
	// cookie never becomes a mysterious "auto-login stopped working".
	$expires = $wants ? time() + 12 * HOUR_IN_SECONDS : time() - YEAR_IN_SECONDS;

	if ( $wants ) {
		// Clears the auth cookies and the session — and, via WooCommerce's own
		// wp_logout handler, the cart.
		wp_logout();
	}
	setcookie( KROKEDIL_PG_GUEST_COOKIE, '1', $expires, $path, COOKIE_DOMAIN );
	if ( $wants ) {
		$_COOKIE[ KROKEDIL_PG_GUEST_COOKIE ] = '1';
	} else {
		unset( $_COOKIE[ KROKEDIL_PG_GUEST_COOKIE ] );
	}

	wp_safe_redirect( remove_query_arg( KROKEDIL_PG_GUEST_PARAM ) );
	exit;
}
add_action( 'init', 'krokedil_pg_dev_login_guest_toggle', 0 );

/**
 * Offer a one-click way into guest mode from the admin bar.
 *
 * The way back is `?krokedil-guest=0` (a guest has no admin bar to click) or
 * the login form with the documented credentials.
 *
 * @param WP_Admin_Bar $bar The admin bar instance.
 */
function krokedil_pg_dev_login_admin_bar( $bar ) {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$bar->add_node(
		array(
			'id'    => 'krokedil-pg-guest',
			'title' => 'Browse as guest',
			'href'  => add_query_arg( KROKEDIL_PG_GUEST_PARAM, '1' ),
			'meta'  => array( 'title' => 'Log out and stop auto-login for 12 hours (this browser only)' ),
		)
	);
}
add_action( 'admin_bar_menu', 'krokedil_pg_dev_login_admin_bar', 100 );

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
	// Never over a tunnel: tunnel requests carry the public domain as Host.
	if ( ! krokedil_pg_dev_login_is_local() ) {
		return;
	}
	// Explicit flows that must render the form.
	if ( isset( $_GET['action'] ) || isset( $_GET['loggedout'] ) || isset( $_GET['interim-login'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
		return;
	}
	// Guest mode: this browser asked to stay a visitor, including on the login
	// links that would otherwise silently re-admin it.
	if ( isset( $_COOKIE[ KROKEDIL_PG_GUEST_COOKIE ] ) ) {
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
