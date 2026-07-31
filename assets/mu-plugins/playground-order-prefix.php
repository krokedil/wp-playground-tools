<?php
/**
 * Plugin Name: Playground Order Prefix
 * Description: Prefixes order numbers with this checkout's site id, so several playground sites can share a provider's test merchant. Part of @krokedil/wp-playground-tools; staged into .playground/mu-plugins/ and symlinked into mu-plugins/.
 *
 * Every playground site numbers its first order 1, and payment gateways send
 * that number to the provider as the order's merchant reference — Qliro's
 * MerchantReference, Klarna's merchant_reference1. Two sites on one test
 * merchant therefore collide as soon as both place an order, and the provider
 * rejects the second ("Order with reference '38' already exists"), which fails
 * the purchase.
 *
 * The host tool writes this checkout's id to .playground/site-id.txt; while
 * that file exists, order numbers here read <id>-<n>. The id is derived from
 * the checkout path, so it is stable for a worktree — a provider that stored a
 * reference keeps matching it — and different for every other checkout. It is
 * the same id the wildcard tunnel host carries, so a reference in a provider's
 * portal names the site that created it.
 *
 * Display only: the underlying order ID is untouched, so nothing that looks an
 * order up by ID is affected.
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Read this site's id token. __DIR__ resolves through the mu-plugins symlink
 * to .playground/mu-plugins/, so the id file is one level up.
 *
 * @return string The token, or '' when there is none (then this file is inert).
 */
function krokedil_pg_order_prefix_id() {
	static $id = null;
	if ( null !== $id ) {
		return $id;
	}
	$file = dirname( __DIR__ ) . '/site-id.txt';
	$raw  = is_readable( $file ) ? trim( (string) file_get_contents( $file ) ) : '';
	// Written by the tool as hex plus an optional "-<n>" reprovision counter;
	// anything else means a stale or hand-edited file, so stay out of the way.
	$id = preg_match( '/^[a-f0-9]{4,}(-\d+)?$/', $raw ) ? $raw : '';
	return $id;
}

/**
 * Prefix an order number with the site id.
 *
 * @param string $number The order number so far.
 * @return string Prefixed order number.
 */
function krokedil_pg_order_prefix_number( $number ) {
	$id     = krokedil_pg_order_prefix_id();
	$number = (string) $number;
	// Idempotent: WooCommerce and other filters may pass a value through more
	// than once, and returns-and-withdrawals builds its numbers from an
	// already-prefixed parent.
	if ( '' === $id || 0 === strpos( $number, $id . '-' ) ) {
		return $number;
	}
	return $id . '-' . $number;
}

if ( '' !== krokedil_pg_order_prefix_id() ) {
	// Priority 5: below plugins that *replace* the number from their own meta
	// (returns-and-withdrawals filters at 10000), so they build on the
	// prefixed parent number instead of dropping the prefix.
	add_filter( 'woocommerce_order_number', 'krokedil_pg_order_prefix_number', 5 );
}
