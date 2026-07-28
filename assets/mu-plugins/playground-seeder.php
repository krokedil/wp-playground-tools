<?php
/**
 * Plugin Name: Playground Seeder
 * Description: Plugin-agnostic helpers for seeding tax classes, tax rates, products, and orders into a WordPress Playground site from a JSON definition file. Lives at tools/blueprints/ so any sibling blueprint that needs declarative seed data can symlink it into mu-plugins/ and pass the absolute path to its own playground-seeder-data.json. In this repo the development blueprint is the only consumer; demo/ and e2e/ provision their fixtures inline via runPHP + wp-cli steps.
 * Version: 1.0.0
 *
 * @package Playground/Seeder
 *
 * Overview:
 * Declarative WooCommerce seeder for WP Playground (or any WP site). All data
 * lives in a sibling playground-seeder-data.json file that this seeder reads
 * once per request and caches in memory. Every seed function is idempotent —
 * existing entities are matched against the JSON (by SKU, code, name, slug,
 * country+class+rate, etc.) and skipped, so the blueprint can be re-run
 * without producing duplicates.
 *
 * Use in a Playground blueprint:
 * The blueprint at tools/blueprints/development/blueprint.json shows the
 * pattern. In short:
 *   1. mkdir /wordpress/wp-content/mu-plugins
 *   2. symlink this file into mu-plugins so it auto-loads before regular
 *      plugins:
 *        symlink(
 *          '/wordpress/wp-content/plugins/<your-plugin>/tools/blueprints/playground-seeder.php',
 *          '/wordpress/wp-content/mu-plugins/playground-seeder.php'
 *        );
 *   3. After wp-load.php is required, call whichever playground_seed_*
 *      functions you need (typically all of them, in dependency order),
 *      passing the absolute path to your blueprint's JSON file as $path.
 *
 * Reuse in another plugin:
 *   1. Copy playground-seeder.php into that plugin's tools/blueprints/.
 *   2. Add an tools/blueprints/<env>/playground-seeder-data.json with the
 *      products / coupons / orders that env needs. The shape is documented
 *      below.
 *   3. In that plugin's blueprint, symlink the seeder into mu-plugins and
 *      call the seed functions from a runPHP step, passing the absolute
 *      path to the JSON.
 *
 * JSON shape (top-level keys, all optional):
 *   tax_classes        Array of class names. Created via WC_Tax::create_tax_class().
 *   tax_rates          Array of { country, rate, class, name, ... }. Matched by
 *                      country + class slug + rate.
 *   product_attributes Array of { name, slug, type, ... }. Global attribute
 *                      taxonomies, matched by slug.
 *   products           Array of product specs. type=simple (default) or
 *                      type=variable with nested attributes[] and variations[].
 *                      Matched by SKU; variations also matched by SKU.
 *   coupons            Array of { code, amount, discount_type, ... }. Matched
 *                      by code.
 *   shipping_zones     Array of { name, methods[] }. Zones matched by name;
 *                      methods within a zone matched by method_id.
 *   order_defaults     Base template (customer_id, items, billing,
 *                      payment_method, ...) merged under each orders[] entry
 *                      with array_replace_recursive. Also the source for
 *                      playground_seed_user_billing().
 *   orders             Array of per-order overrides (status, items, ...). One
 *                      order is created per entry on every run — orders are
 *                      not deduplicated.
 *
 * Public function surface (all accept an optional $path override pointing at
 * the JSON file; default falls back to playground-seeder-data.json next to
 * this seeder, but consumers should pass the absolute path to their own
 * blueprint's JSON):
 *   playground_seed_data( $path = null )                      Load + cache the JSON.
 *   playground_seed_tax_classes( $path = null )               Create missing tax classes.
 *   playground_seed_tax_rates( $path = null )                 Create missing tax rates.
 *   playground_seed_product_attributes( $path = null )        Create missing global attributes.
 *   playground_seed_products( $path = null )                  Create missing products + variations.
 *   playground_seed_coupons( $path = null )                   Create missing coupons.
 *   playground_seed_shipping_zones( $path = null )            Create/update zones and methods.
 *   playground_seed_user_billing( $user_id = 1, $path = null) Apply order_defaults.billing as billing_* user meta.
 *   playground_create_order_from_template( $template, $path ) Create one order from a template.
 *   playground_seed_orders( $path = null )                    Create one order per orders[] entry.
 *
 * Requirements:
 * Each function early-returns an empty result if the WooCommerce class or
 * function it depends on is not loaded, so this file is safe to require even
 * before WooCommerce activates. Call the seed functions after wp-load.php
 * (and after WooCommerce is active) for them to do real work.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Load and cache the declarative seed data from a JSON file.
 *
 * @param string|null $path Absolute path to the JSON file. Defaults to playground-seeder-data.json next to this seeder file.
 * @return array
 */
function playground_seed_data( $path = null ) {
	static $cache = array();
	$path         = $path ? $path : __DIR__ . '/playground-seeder-data.json';
	if ( isset( $cache[ $path ] ) ) {
		return $cache[ $path ];
	}
	$json = is_readable( $path ) ? file_get_contents( $path ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
	$data = $json ? json_decode( $json, true ) : array();
	if ( ! is_array( $data ) ) {
		$data = array();
	}
	$cache[ $path ] = $data;
	return $data;
}

/**
 * Create any tax classes from the seed data that don't already exist.
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return string[] Names of created tax classes.
 */
function playground_seed_tax_classes( $path = null ) {
	if ( ! class_exists( 'WC_Tax' ) ) {
		return array();
	}
	$data     = playground_seed_data( $path );
	$names    = $data['tax_classes'] ?? array();
	$existing = WC_Tax::get_tax_classes();
	$created  = array();
	foreach ( $names as $name ) {
		if ( in_array( $name, $existing, true ) ) {
			continue;
		}
		$result = WC_Tax::create_tax_class( $name );
		if ( ! is_wp_error( $result ) ) {
			$created[] = $name;
		}
	}
	return $created;
}

/**
 * Create any tax rates from the seed data that don't already exist
 * (matched by country + class slug + rate).
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created tax rates.
 */
function playground_seed_tax_rates( $path = null ) {
	global $wpdb;
	if ( ! class_exists( 'WC_Tax' ) ) {
		return array();
	}
	$data    = playground_seed_data( $path );
	$rates   = $data['tax_rates'] ?? array();
	$created = array();
	foreach ( $rates as $rate_spec ) {
		$country = $rate_spec['country'] ?? '';
		$rate    = isset( $rate_spec['rate'] ) ? (string) $rate_spec['rate'] : '';
		$class   = sanitize_title( $rate_spec['class'] ?? '' );
		if ( '' === $country || '' === $rate ) {
			continue;
		}

		$exists = $wpdb->get_var( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
			$wpdb->prepare(
				"SELECT tax_rate_id FROM {$wpdb->prefix}woocommerce_tax_rates
				 WHERE tax_rate_country = %s AND tax_rate_class = %s AND tax_rate = %s LIMIT 1",
				$country,
				$class,
				$rate
			)
		);
		if ( $exists ) {
			continue;
		}

		$tax_rate_id = WC_Tax::_insert_tax_rate(
			array(
				'tax_rate_country'  => $country,
				'tax_rate_state'    => $rate_spec['state'] ?? '',
				'tax_rate'          => $rate,
				'tax_rate_name'     => $rate_spec['name'] ?? $rate,
				'tax_rate_priority' => $rate_spec['priority'] ?? 1,
				'tax_rate_compound' => $rate_spec['compound'] ?? 0,
				'tax_rate_shipping' => $rate_spec['shipping'] ?? 1,
				'tax_rate_order'    => $rate_spec['order'] ?? 0,
				'tax_rate_class'    => $class,
			)
		);
		if ( $tax_rate_id ) {
			$created[] = (int) $tax_rate_id;
		}
	}
	return $created;
}

/**
 * Create any global product attributes (taxonomies) from the seed data
 * that don't already exist (matched by slug).
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created attribute taxonomies.
 */
function playground_seed_product_attributes( $path = null ) {
	if ( ! function_exists( 'wc_create_attribute' ) ) {
		return array();
	}
	$data    = playground_seed_data( $path );
	$created = array();
	foreach ( $data['product_attributes'] ?? array() as $spec ) {
		$name = $spec['name'] ?? '';
		$slug = sanitize_title( $spec['slug'] ?? $name );
		if ( '' === $name || '' === $slug ) {
			continue;
		}
		if ( wc_attribute_taxonomy_id_by_name( $slug ) ) {
			// Still register the taxonomy so terms can be inserted in the same request.
			$taxonomy = wc_attribute_taxonomy_name( $slug );
			if ( ! taxonomy_exists( $taxonomy ) ) {
				register_taxonomy( $taxonomy, 'product', array() );
			}
			continue;
		}
		$id = wc_create_attribute(
			array(
				'name'         => $name,
				'slug'         => $slug,
				'type'         => $spec['type'] ?? 'select',
				'order_by'     => $spec['order_by'] ?? 'menu_order',
				'has_archives' => $spec['has_archives'] ?? false,
			)
		);
		if ( ! is_wp_error( $id ) ) {
			$taxonomy = wc_attribute_taxonomy_name( $slug );
			if ( ! taxonomy_exists( $taxonomy ) ) {
				register_taxonomy( $taxonomy, 'product', array() );
			}
			$created[] = (int) $id;
		}
	}
	return $created;
}

/**
 * Create any products from the seed data that don't already exist (matched by SKU).
 * Supports simple and variable products. Variable products may include nested
 * variations and attribute definitions.
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created products (parents only; variations not counted).
 */
function playground_seed_products( $path = null ) {
	if ( ! class_exists( 'WC_Product_Simple' ) ) {
		return array();
	}
	$data    = playground_seed_data( $path );
	$created = array();
	foreach ( $data['products'] ?? array() as $spec ) {
		$sku = $spec['sku'] ?? '';
		if ( '' === $sku || wc_get_product_id_by_sku( $sku ) ) {
			continue;
		}
		$type = $spec['type'] ?? 'simple';

		if ( 'variable' === $type && class_exists( 'WC_Product_Variable' ) ) {
			$product = new WC_Product_Variable();
		} else {
			$product = new WC_Product_Simple();
		}
		$product->set_name( $spec['name'] ?? $sku );
		$product->set_sku( $sku );
		if ( isset( $spec['regular_price'] ) ) {
			$product->set_regular_price( (string) $spec['regular_price'] );
		}
		if ( isset( $spec['tax_class'] ) ) {
			$product->set_tax_class( sanitize_title( $spec['tax_class'] ) );
		}
		$product->set_virtual( ! empty( $spec['virtual'] ) );
		$product->set_downloadable( ! empty( $spec['downloadable'] ) );

		if ( 'variable' === $type && ! empty( $spec['attributes'] ) ) {
			$product_attrs = array();
			foreach ( $spec['attributes'] as $attr_spec ) {
				$attr_name    = $attr_spec['name'] ?? '';
				$slug         = sanitize_title( $attr_name );
				$taxonomy     = wc_attribute_taxonomy_name( $slug );
				$attribute_id = wc_attribute_taxonomy_id_by_name( $slug );
				$product_attr = new WC_Product_Attribute();
				if ( $attribute_id ) {
					$product_attr->set_id( $attribute_id );
					$product_attr->set_name( $taxonomy );
					$resolved_options = array();
					foreach ( $attr_spec['options'] ?? array() as $term_name ) {
						if ( ! term_exists( $term_name, $taxonomy ) ) {
							$inserted = wp_insert_term( $term_name, $taxonomy );
							if ( is_wp_error( $inserted ) ) {
								continue;
							}
						}
						$resolved_options[] = $term_name;
					}
					$product_attr->set_options( $resolved_options );
				} else {
					$product_attr->set_name( $attr_name );
					$product_attr->set_options( $attr_spec['options'] ?? array() );
				}
				$product_attr->set_visible( $attr_spec['visible'] ?? true );
				$product_attr->set_variation( $attr_spec['variation'] ?? true );
				$product_attrs[] = $product_attr;
			}
			$product->set_attributes( $product_attrs );
		}

		$product->save();

		if ( 'variable' === $type && $product instanceof WC_Product_Variable && ! empty( $spec['variations'] ) ) {
			foreach ( $spec['variations'] as $var_spec ) {
				$var_sku = $var_spec['sku'] ?? '';
				if ( '' === $var_sku || wc_get_product_id_by_sku( $var_sku ) ) {
					continue;
				}
				$variation = new WC_Product_Variation();
				$variation->set_parent_id( $product->get_id() );
				$variation->set_sku( $var_sku );
				if ( isset( $var_spec['regular_price'] ) ) {
					$variation->set_regular_price( (string) $var_spec['regular_price'] );
				}
				if ( ! empty( $var_spec['attributes'] ) ) {
					$var_attrs = array();
					foreach ( $var_spec['attributes'] as $attr_name => $attr_value ) {
						$slug = sanitize_title( $attr_name );
						if ( wc_attribute_taxonomy_id_by_name( $slug ) ) {
							$var_attrs[ wc_attribute_taxonomy_name( $slug ) ] = sanitize_title( $attr_value );
						} else {
							$var_attrs[ sanitize_title( $attr_name ) ] = (string) $attr_value;
						}
					}
					$variation->set_attributes( $var_attrs );
				}
				$variation->save();
			}
			// Recompute parent's variation prices/stock cache.
			WC_Product_Variable::sync( $product->get_id() );
		}

		$created[] = $product->get_id();
	}
	return $created;
}

/**
 * Create any coupons from the seed data that don't already exist (matched by code).
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created coupons.
 */
function playground_seed_coupons( $path = null ) {
	if ( ! class_exists( 'WC_Coupon' ) ) {
		return array();
	}
	$data    = playground_seed_data( $path );
	$created = array();
	foreach ( $data['coupons'] ?? array() as $spec ) {
		$code = $spec['code'] ?? '';
		if ( '' === $code || wc_get_coupon_id_by_code( $code ) ) {
			continue;
		}
		$coupon = new WC_Coupon();
		$coupon->set_code( $code );
		if ( isset( $spec['amount'] ) ) {
			$coupon->set_amount( (string) $spec['amount'] );
		}
		if ( isset( $spec['discount_type'] ) ) {
			$coupon->set_discount_type( $spec['discount_type'] );
		}
		if ( isset( $spec['free_shipping'] ) ) {
			$coupon->set_free_shipping( (bool) $spec['free_shipping'] );
		}
		if ( isset( $spec['description'] ) ) {
			$coupon->set_description( (string) $spec['description'] );
		}
		$coupon->save();
		$created[] = $coupon->get_id();
	}
	return $created;
}

/**
 * Create any shipping zones from the seed data that don't already exist (matched by name)
 * and add any shipping methods that aren't already on the zone (matched by method_id).
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created or updated shipping zones.
 */
function playground_seed_shipping_zones( $path = null ) {
	global $wpdb;
	if ( ! class_exists( 'WC_Shipping_Zone' ) || ! class_exists( 'WC_Shipping_Zones' ) ) {
		return array();
	}
	$data    = playground_seed_data( $path );
	$touched = array();

	$existing_by_name = array();
	foreach ( WC_Shipping_Zones::get_zones() as $z ) {
		$existing_by_name[ $z['zone_name'] ] = $z['id'];
	}

	foreach ( $data['shipping_zones'] ?? array() as $spec ) {
		$name = $spec['name'] ?? '';
		if ( '' === $name ) {
			continue;
		}
		if ( isset( $existing_by_name[ $name ] ) ) {
			$zone = new WC_Shipping_Zone( $existing_by_name[ $name ] );
		} else {
			$zone = new WC_Shipping_Zone();
			$zone->set_zone_name( $name );
			$zone->save();
		}

		$existing_method_ids = array();
		foreach ( $zone->get_shipping_methods() as $method ) {
			$existing_method_ids[] = $method->id;
		}

		foreach ( $spec['methods'] ?? array() as $method_spec ) {
			$method_id = $method_spec['method_id'] ?? '';
			if ( '' === $method_id || in_array( $method_id, $existing_method_ids, true ) ) {
				continue;
			}
			$instance_id = $zone->add_shipping_method( $method_id );
			if ( ! $instance_id ) {
				continue;
			}
			if ( ! empty( $method_spec['settings'] ) ) {
				$option_key      = 'woocommerce_' . $method_id . '_' . $instance_id . '_settings';
				$existing_option = get_option( $option_key, array() );
				update_option( $option_key, array_merge( (array) $existing_option, $method_spec['settings'] ) );
			}
			if ( isset( $method_spec['enabled'] ) ) {
				$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
					$wpdb->prefix . 'woocommerce_shipping_zone_methods',
					array( 'is_enabled' => $method_spec['enabled'] ? 1 : 0 ),
					array( 'instance_id' => $instance_id ),
					array( '%d' ),
					array( '%d' )
				);
			}
		}

		$touched[] = (int) $zone->get_id();
	}
	return $touched;
}

/**
 * Apply order_defaults.billing as billing_* user meta on the given user, so
 * WooCommerce prefills checkout for them. Idempotent — overwrites existing values.
 *
 * @param int         $user_id User ID to apply billing details to. Defaults to 1 (admin).
 * @param string|null $path    Optional path to the seed JSON file.
 * @return bool True on success, false if user missing or no billing data.
 */
function playground_seed_user_billing( $user_id = 1, $path = null ) {
	$data    = playground_seed_data( $path );
	$billing = $data['order_defaults']['billing'] ?? array();
	if ( empty( $billing ) || ! get_user_by( 'id', $user_id ) ) {
		return false;
	}
	foreach ( $billing as $key => $value ) {
		update_user_meta( $user_id, 'billing_' . sanitize_key( $key ), (string) $value );
	}
	return true;
}

/**
 * Create one order from a template merged on top of the seed data's order_defaults.
 *
 * @param array       $template Per-instance overrides (e.g. status).
 * @param string|null $path     Optional path to the seed JSON file.
 * @return int|null Created order ID, or null on failure.
 */
function playground_create_order_from_template( $template, $path = null ) {
	if ( ! function_exists( 'wc_create_order' ) ) {
		return null;
	}
	$data   = playground_seed_data( $path );
	$merged = array_replace_recursive( $data['order_defaults'] ?? array(), (array) $template );

	$order = wc_create_order( array( 'customer_id' => $merged['customer_id'] ?? 1 ) );
	if ( is_wp_error( $order ) ) {
		return null;
	}
	foreach ( $merged['items'] ?? array() as $item ) {
		if ( empty( $item['sku'] ) ) {
			continue;
		}
		$product_id = wc_get_product_id_by_sku( $item['sku'] );
		$product    = $product_id ? wc_get_product( $product_id ) : null;
		if ( $product ) {
			$order->add_product( $product, $item['quantity'] ?? 1 );
		}
	}
	if ( ! empty( $merged['shipping'] ) ) {
		$ship_data = $merged['shipping'];
		$total     = (float) ( $ship_data['total'] ?? 0 );
		$method_id = $ship_data['method_id'] ?? 'flat_rate';
		$rate      = new WC_Shipping_Rate(
			$method_id,
			$ship_data['method_title'] ?? 'Flat rate',
			$total,
			array(),
			$method_id
		);
		$shipping  = new WC_Order_Item_Shipping();
		$shipping->set_shipping_rate( $rate );
		$shipping->set_total( $total );
		$order->add_item( $shipping );
	}
	if ( ! empty( $merged['billing'] ) ) {
		$order->set_address( $merged['billing'], 'billing' );
	}
	if ( ! empty( $merged['payment_method'] ) ) {
		$order->set_payment_method( $merged['payment_method'] );
		$order->set_payment_method_title( $merged['payment_method_title'] ?? '' );
	}
	$order->calculate_totals();
	if ( ! empty( $merged['status'] ) ) {
		$order->update_status( $merged['status'] );
	}
	$order->save();
	return $order->get_id();
}

/**
 * Create one order per template defined in the seed data's "orders" array.
 *
 * @param string|null $path Optional path to the seed JSON file.
 * @return int[] IDs of created orders.
 */
function playground_seed_orders( $path = null ) {
	$data    = playground_seed_data( $path );
	$created = array();
	foreach ( $data['orders'] ?? array() as $template ) {
		$id = playground_create_order_from_template( $template, $path );
		if ( $id ) {
			$created[] = $id;
		}
	}
	return $created;
}
