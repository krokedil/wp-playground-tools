<?php
/**
 * Plugin Name: Playground Tunnel Guard
 * Description: Requires a per-run password for wp-admin logins arriving through a tunnel. Part of @krokedil/wp-playground-tools; staged into .playground/mu-plugins/ and symlinked into mu-plugins/.
 *
 * A `--tunnel` URL is reachable by anyone on the internet who has it, and the
 * Playground admin credentials are the documented default `admin` / `password`
 * — so without this, the URL is one form submission away from handing a
 * stranger the dashboard of a site holding your provider test keys.
 *
 * So requests that did *not* come from this machine:
 *
 *   - can only log in with the running tunnel's password, which the host tool
 *     writes to .playground/tunnel-password.txt (deleted on exit and before
 *     every launch). The default `password` is refused, for every user, so a
 *     stranger who knows Playground's defaults gets nowhere — and when there is
 *     no readable password file, no remote login is possible at all;
 *   - never get Playground's built-in auto-login. That auto-login authenticates
 *     on a cookie marker with no password check whatsoever, so it must never
 *     answer a public request. It is not armed in the modes this tool runs
 *     today (verified against @wp-playground/cli 3.1.x), which is why the
 *     `--tunnel` login form appears at all — this keeps that true if a future
 *     CLI arms it.
 *
 * Local requests are untouched: normal password checks, the development
 * auto-login in playground-dev-login.php, and the screenshots flow all keep
 * working. Everything else (the storefront, REST callbacks, webhooks) stays
 * public — gating those is the whole reason a tunnel exists.
 *
 * A guarded site is still a dev site: keep production keys and real customer
 * data out of it regardless (see the secrets warning in the README).
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Path of the password file the host tool writes while a tunnel is running.
 *
 * __DIR__ resolves through the mu-plugins symlink to .playground/mu-plugins/,
 * so the file is one level up — same contract as krokedil_pg_proxy_url().
 *
 * @return string Absolute path inside the runtime.
 */
function krokedil_pg_tunnel_password_file() {
	return dirname( __DIR__ ) . '/tunnel-password.txt';
}

/**
 * The password required for logins from off this machine.
 *
 * '' means there is none to be had — no tunnel running, a file the runtime
 * can't read (host permissions it sees through a different uid), a truncated
 * write, or a second launch in the same worktree having cleared it while this
 * run's tunnel is still up. Every one of those must mean "no remote login",
 * never "no gate": each of them has left the default `password` working on a
 * public URL at some point during development.
 *
 * @return string The password, or '' when it can't be read.
 */
function krokedil_pg_tunnel_password() {
	static $password = null;
	if ( null !== $password ) {
		return $password;
	}
	$file     = krokedil_pg_tunnel_password_file();
	$password = is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : '';
	return $password;
}

/**
 * Whether the request was addressed to the machine itself.
 *
 * Same trust rule as krokedil_pg_dev_login_is_local(), duplicated on purpose:
 * that mu-plugin is only staged in development mode, and a guard that fails
 * open when its neighbour is absent would be worthless. Hostnames are the
 * primary signal — a tunnel agent connects from loopback, so REMOTE_ADDR
 * alone can't tell tunnel traffic apart, but ngrok's edge routes by Host and
 * delivers the tunnel domain (a spoofed localhost Host never reaches it),
 * while the local https proxy forwards Host/X-Forwarded-Host: localhost:<port>.
 * A loopback REMOTE_ADDR is additionally required when the SAPI provides one,
 * so a LAN client spoofing a localhost Host is treated as remote.
 *
 * Requests without a Host (wp-cli during provisioning, cron) are local: they
 * originate inside the runtime, and no login form is involved.
 *
 * @return bool True when the peer (if known) and every host name are loopback.
 */
function krokedil_pg_tunnel_is_local() {
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
	return true;
}

// Keyed on where the request came from, not on the password file existing: a
// request from off this machine arrived through some proxy or tunnel, and the
// site it reached has a documented default password. Whether we can offer it a
// login at all depends on the password file, but the gate goes up regardless —
// keying on the file would leave the site open in exactly the cases the file
// is missing when it shouldn't be.
if ( ! krokedil_pg_tunnel_is_local() ) {
	// Disarm Playground's built-in auto-login for this request. It runs on
	// `init` from an internal mu-plugin loaded on muplugins_loaded — later than
	// this file — and bails when the marker is present, so setting the marker
	// here is enough. The ?playground_force_auto_login_as_user variant needs a
	// constant we never define, but it costs nothing to close too.
	$_COOKIE['playground_auto_login_already_happened'] = '1';
	unset( $_GET['playground_force_auto_login_as_user'] );

	/**
	 * Accept only the tunnel password for logins arriving over the tunnel.
	 *
	 * Covers wp-login.php and XML-RPC, which both authenticate through
	 * wp_check_password(). Existing sessions are unaffected — cookies can only
	 * be minted by logging in, which is what this gates.
	 *
	 * @param bool   $check    Whether the submitted password matches the hash.
	 * @param string $password The submitted password.
	 * @return bool True only for the tunnel password.
	 */
	function krokedil_pg_tunnel_check_password( $check, $password ) {
		$expected = krokedil_pg_tunnel_password();
		if ( '' === $expected ) {
			return false; // Unreadable password file: nobody logs in remotely.
		}
		return hash_equals( $expected, (string) $password );
	}
	add_filter( 'check_password', 'krokedil_pg_tunnel_check_password', 1000, 2 );
}
