/**
 * Shared Playground blueprint step library.
 *
 * Each function returns one step object (or an array of them) for the
 * composer. Everything org-generic lives here; plugin-specific values are
 * threaded in from playground.config.mjs by compose.mjs. Anything a single
 * plugin needs beyond this vocabulary belongs in config.extraSteps as raw
 * blueprint JSON — resist adding one-plugin step builders.
 */

/** In-container WordPress root. */
export const WP_ROOT = '/wordpress';

/**
 * In-container path of the mounted plugin.
 *
 * @param {string} slug Plugin slug.
 * @return {string} Absolute container path.
 */
export function pluginContainerPath(slug) {
	return `${WP_ROOT}/wp-content/plugins/${slug}`;
}

/**
 * WP_DEBUG constants. Development keeps a persistent debug.log; other modes
 * silence debug output.
 *
 * @param {boolean} enabled Whether debugging is on.
 * @return {Object} defineWpConfigConsts step.
 */
export function debugConsts(enabled) {
	return {
		step: 'defineWpConfigConsts',
		consts: enabled
			? { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false }
			: { WP_DEBUG: false },
	};
}

/**
 * Turn off WordPress's background automatic updater (core, plugins, themes,
 * translations) — every mode.
 *
 * Playground sites are throwaway and version-pinned by the blueprint, so a
 * background update never helps — and it actively breaks the multi-worker
 * runtime: the updater's file churn from one PHP worker desyncs the other
 * workers' views of the shared filesystem (observed: every request fatals on
 * a `.maintenance` file that no longer exists), and its burst of writes lands
 * on the same SQLite file the other workers are serving from.
 *
 * @return {Object} defineWpConfigConsts step.
 */
export function disableAutoUpdates() {
	return {
		step: 'defineWpConfigConsts',
		// rewrite-wp-config, not the define-before-run default: that one only
		// defines constants for the boot that runs the blueprint, and warm
		// boots of the persistent site skip the blueprint — the constant must
		// live in the site's wp-config.php to hold across relaunches.
		method: 'rewrite-wp-config',
		consts: { AUTOMATIC_UPDATER_DISABLED: true },
	};
}

/**
 * Reset the site content. The persistent development site uses `wp site empty`
 * (keeps users/options so a re-applied blueprint stays idempotent); ephemeral
 * servers use the CLI's full resetData.
 *
 * @param {boolean} persistent Whether this blueprint provisions the persistent site.
 * @return {Object} Reset step.
 */
export function reset(persistent) {
	return persistent
		? { step: 'wp-cli', command: 'wp site empty --yes' }
		: { step: 'resetData' };
}

/**
 * Delete the stock hello.php plugin and the akismet directory.
 *
 * @return {Object} runPHP step.
 */
export function removeDefaultPlugins() {
	return {
		step: 'runPHP',
		code: `<?php @unlink('${WP_ROOT}/wp-content/plugins/hello.php'); $akismet = '${WP_ROOT}/wp-content/plugins/akismet'; if (is_dir($akismet)) { $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($akismet, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST); foreach ($items as $item) { $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname()); } @rmdir($akismet); }`,
	};
}

/**
 * Install + activate Storefront, prune other themes, reset widgets and turn
 * off product pagination (screenshot stability).
 *
 * @return {Object[]} Theme setup steps.
 */
export function storefrontTheme() {
	return [
		{
			step: 'installTheme',
			themeData: { resource: 'wordpress.org/themes', slug: 'storefront' },
			options: { activate: true },
		},
		{ step: 'wp-cli', command: 'wp theme delete --all' },
		{ step: 'wp-cli', command: 'wp widget reset --all' },
		{
			step: 'wp-cli',
			command: 'wp theme mod set storefront_product_pagination 0',
		},
	];
}

/**
 * Site identity + formatting options.
 *
 * @param {Object} config  Normalized plugin config.
 * @param {string} tagline Mode tagline ("Development by Krokedil", ...).
 * @return {Object} setSiteOptions step.
 */
export function siteIdentity(config, tagline) {
	return {
		step: 'setSiteOptions',
		options: {
			blogname: config.siteName,
			blogdescription: config.siteTagline ?? tagline,
			date_format: 'Y-m-d',
			time_format: 'H:i',
			start_of_week: '1',
			timezone_string: config.store.timezone,
			blog_public: '0',
			show_on_front: 'page',
			permalink_structure: '/%postname%/',
		},
	};
}

/**
 * Flush rewrite rules so the pretty permalinks take effect.
 *
 * @return {Object} runPHP step.
 */
export function flushRewrite() {
	return {
		step: 'runPHP',
		code: `<?php require '${WP_ROOT}/wp-load.php'; $wp_rewrite->flush_rules();`,
	};
}

/**
 * Install WooCommerce and suppress every onboarding/tour/tracking surface,
 * then apply the org-baseline store options.
 *
 * @param {Object} store Config.store (country/currency).
 * @return {Object[]} WooCommerce baseline steps.
 */
export function wooCommerceBaseline(store) {
	return [
		{
			step: 'installPlugin',
			pluginData: {
				resource: 'wordpress.org/plugins',
				slug: 'woocommerce',
			},
			options: { activate: true },
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_onboarding_profile: { skipped: true },
				woocommerce_task_list_hidden: 'yes',
				woocommerce_task_list_reminder_bar_hidden: 'yes',
				woocommerce_allow_tracking: 'no',
				woocommerce_show_marketplace_suggestions: 'no',
				woocommerce_block_product_tour_shown: 'yes',
				woocommerce_orders_report_date_tour_shown: 'yes',
				woocommerce_revenue_report_date_tour_shown: 'yes',
			},
		},
		{
			step: 'wp-cli',
			command: 'wp transient delete _wc_activation_redirect',
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_default_country: store.country,
				woocommerce_currency: store.currency,
				woocommerce_price_num_decimals: '2',
				woocommerce_currency_pos: 'right_space',
				woocommerce_coming_soon: 'no',
				woocommerce_store_pages_only: 'no',
				woocommerce_calc_taxes: 'yes',
				woocommerce_enable_coupons: 'yes',
				// Legacy storage by default; HPOS runs flip this themselves.
				woocommerce_custom_orders_table_enabled: 'no',
			},
		},
	];
}

/**
 * Wire the WooCommerce utility pages: publish + register the refund/returns
 * page as terms, make the shop page the front page, and force the checkout
 * page to the classic shortcode.
 *
 * @return {Object[]} runPHP steps.
 */
export function wooCommercePages() {
	return [
		{
			step: 'runPHP',
			code: `<?php require_once '${WP_ROOT}/wp-load.php'; $page = get_page_by_path('refund_returns'); if ($page) { wp_publish_post($page->ID); update_option('woocommerce_terms_page_id', $page->ID); }`,
		},
		{
			step: 'runPHP',
			code: `<?php require_once '${WP_ROOT}/wp-load.php'; $shop_page_id = get_option('woocommerce_shop_page_id'); if ($shop_page_id) { update_option('page_on_front', $shop_page_id); update_option('show_on_front', 'page'); }`,
		},
		{
			step: 'runPHP',
			code: `<?php require_once '${WP_ROOT}/wp-load.php'; $checkout_page_id = get_option('woocommerce_checkout_page_id'); if ($checkout_page_id) { wp_update_post(['ID' => $checkout_page_id, 'post_content' => '[woocommerce_checkout]']); }`,
		},
	];
}

/**
 * The development-mode debug plugin bundle. Installed WITHOUT the CLI's
 * activate option and activated via wp-cli instead: the CLI's activatePlugin
 * chokes on plugins that emit output/redirect during activation (seen with
 * wp-mail-logging on a WooCommerce site — "Could not unlink
 * /tmp/playground-activate-plugin.log"), while wp-cli tolerates it.
 *
 * @return {Object[]} installPlugin steps + one wp-cli activation.
 */
export function debugPlugins() {
	const slugs = [
		'query-monitor',
		'show-hidden-post-meta',
		'transients-manager',
		'wp-mail-logging',
	];
	return [
		...slugs.map((slug) => ({
			step: 'installPlugin',
			pluginData: { resource: 'wordpress.org/plugins', slug },
			options: { activate: false },
		})),
		{
			step: 'wp-cli',
			command: `wp plugin activate ${slugs.join(' ')}`,
		},
	];
}

/**
 * A simple BACS gateway so orders can be placed without a real gateway
 * (development mode; demo mode uses COD via demoStoreConfig).
 *
 * @return {Object} setSiteOptions step.
 */
export function bacsGateway() {
	return {
		step: 'setSiteOptions',
		options: {
			woocommerce_bacs_settings: {
				enabled: 'yes',
				title: 'Direct bank transfer',
				description:
					'Make your payment directly into our bank account. Please use your Order ID as the payment reference.',
				instructions:
					'Please use your Order ID as the payment reference.',
				account_details: [],
			},
		},
	};
}

/**
 * The demo-mode store configuration cascade: a fully configured SE store
 * (address, shipping, tax display, guest checkout, COD, WC feature flags).
 *
 * @param {Object} store Config.store.
 * @return {Object[]} setSiteOptions steps.
 */
export function demoStoreConfig(store) {
	return [
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_store_address: 'Test Road 1',
				woocommerce_store_address_2: '',
				woocommerce_store_city: 'Arvika',
				woocommerce_store_postcode: '67131',
				woocommerce_allowed_countries: 'specific',
				woocommerce_all_except_countries: '',
				woocommerce_specific_allowed_countries: [store.country],
				woocommerce_ship_to_countries: '',
				woocommerce_specific_ship_to_countries: '',
				woocommerce_default_customer_address: 'base',
				woocommerce_calc_discounts_sequentially: 'no',
				woocommerce_price_thousand_sep: ' ',
				woocommerce_price_decimal_sep: ',',
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_cart_redirect_after_add: 'no',
				woocommerce_enable_ajax_add_to_cart: 'yes',
				woocommerce_weight_unit: 'kg',
				woocommerce_dimension_unit: 'cm',
				woocommerce_manage_stock: 'no',
				woocommerce_hold_stock_minutes: '60',
				woocommerce_hide_out_of_stock_items: 'no',
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_prices_include_tax: 'yes',
				woocommerce_tax_based_on: 'shipping',
				woocommerce_shipping_tax_class: 'inherit',
				woocommerce_tax_round_at_subtotal: 'no',
				woocommerce_tax_classes: '',
				woocommerce_tax_display_shop: 'incl',
				woocommerce_tax_display_cart: 'incl',
				woocommerce_price_display_suffix: '',
				woocommerce_tax_total_display: 'itemized',
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_enable_shipping_calc: 'yes',
				woocommerce_shipping_cost_requires_address: 'no',
				woocommerce_shipping_hide_rates_when_free: 'no',
				woocommerce_ship_to_destination: 'billing',
				woocommerce_shipping_debug_mode: 'no',
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_pickup_location_settings: [],
				pickup_location_pickup_locations: [],
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_enable_guest_checkout: 'yes',
				woocommerce_enable_checkout_login_reminder: 'no',
				woocommerce_enable_signup_and_login_from_checkout: 'no',
				woocommerce_enable_myaccount_registration: 'no',
				woocommerce_registration_generate_password: 'yes',
				woocommerce_delete_inactive_accounts: {
					number: '',
					unit: 'months',
				},
				woocommerce_trash_pending_orders: '',
				woocommerce_trash_failed_orders: '',
				woocommerce_trash_cancelled_orders: '',
				woocommerce_anonymize_refunded_orders: {
					number: '',
					unit: 'months',
				},
				woocommerce_anonymize_completed_orders: {
					number: '',
					unit: 'months',
				},
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_cod_settings: {
					enabled: 'yes',
					title: 'Cash on delivery',
					description: 'Pay with cash upon delivery.',
					instructions: 'Pay with cash upon delivery.',
					enable_for_methods: [],
					enable_for_virtual: 'yes',
				},
			},
		},
		{
			step: 'setSiteOptions',
			options: {
				woocommerce_api_enabled: 'no',
				woocommerce_custom_orders_table_enabled: 'no',
				woocommerce_custom_orders_table_data_sync_enabled: '',
				woocommerce_feature_rate_limit_checkout_enabled: 'no',
				woocommerce_feature_order_attribution_enabled: 'yes',
				woocommerce_feature_site_visibility_badge_enabled: 'yes',
				woocommerce_feature_remote_logging_enabled: 'yes',
				woocommerce_feature_email_improvements_enabled: 'yes',
				woocommerce_feature_blueprint_enabled: 'yes',
				woocommerce_feature_product_block_editor_enabled: 'no',
				woocommerce_hpos_fts_index_enabled: 'no',
				woocommerce_hpos_datastore_caching_enabled: 'no',
				woocommerce_feature_block_email_editor_enabled: 'no',
				woocommerce_feature_cost_of_goods_sold_enabled: 'no',
			},
		},
	];
}

/**
 * Activate the plugin(s) under development.
 *
 * @param {string[]} slugs Plugin slugs to activate.
 * @return {Object[]} wp-cli steps.
 */
export function activatePlugins(slugs) {
	return slugs.map((slug) => ({
		step: 'wp-cli',
		command: `wp plugin activate ${slug} --skip-plugins --skip-themes`,
	}));
}

/**
 * Seed plugin options.
 *
 * @param {Object} options Option name -> value map.
 * @return {Object|null} setSiteOptions step, or null when empty.
 */
export function pluginOptions(options) {
	return Object.keys(options).length
		? { step: 'setSiteOptions', options }
		: null;
}

/**
 * Pre-dismiss the block editor welcome guides for user 1.
 *
 * @return {Object} runPHP step.
 */
export function dismissWelcomeGuides() {
	return {
		step: 'runPHP',
		code: `<?php require_once '${WP_ROOT}/wp-load.php'; global $wpdb; update_user_meta( 1, $wpdb->get_blog_prefix() . 'persisted_preferences', array( 'core/edit-post' => array( 'welcomeGuide' => false, 'welcomeGuideStyles' => false ), 'core/edit-site' => array( 'welcomeGuide' => false, 'welcomeGuideStyles' => false ), 'core/editor' => array( 'welcomeGuide' => false ), '_modified' => gmdate( 'Y-m-d' ) . 'T' . gmdate( 'H:i:s' ) . '.000Z' ) );`,
	};
}

/**
 * Create a page idempotently (skipped when the slug already exists).
 *
 * @param {Object} page         Page definition.
 * @param {string} page.title   Page title.
 * @param {string} page.slug    Page slug.
 * @param {string} page.content Raw post content (blocks/shortcodes).
 * @return {Object} runPHP step.
 */
export function createPage({ title, slug, content }) {
	const escape = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return {
		step: 'runPHP',
		code: `<?php require_once '${WP_ROOT}/wp-load.php'; if ( ! get_page_by_path( '${escape(
			slug
		)}' ) ) { wp_insert_post( [ 'post_type' => 'page', 'post_title' => '${escape(
			title
		)}', 'post_name' => '${escape(
			slug
		)}', 'post_status' => 'publish', 'post_content' => '${escape(
			content
		)}' ] ); }`,
	};
}

/**
 * Create the mu-plugins directory and symlink staged mu-plugin files into it.
 * Targets live inside the mounted plugin at .playground/mu-plugins/, so the
 * host tool can restage them at any time without touching the site.
 *
 * @param {string}   slug      Plugin slug (mount location).
 * @param {string[]} basenames Staged mu-plugin file names.
 * @return {Object[]} mkdir + symlink steps.
 */
export function linkMuPlugins(slug, basenames) {
	const stagedDir = `${pluginContainerPath(slug)}/.playground/mu-plugins`;
	return [
		{ step: 'mkdir', path: `${WP_ROOT}/wp-content/mu-plugins` },
		...basenames.map((name) => ({
			step: 'runPHP',
			code: `<?php $target = '${stagedDir}/${name}'; $link = '${WP_ROOT}/wp-content/mu-plugins/${name}'; if ( ! file_exists( $link ) ) { symlink( $target, $link ); }`,
		})),
	];
}

/**
 * Invoke the declarative seeder against the staged seed-data JSON.
 *
 * @param {string} slug Plugin slug (mount location).
 * @return {Object} runPHP step.
 */
export function seedInvocation(slug) {
	const dataPath = `${pluginContainerPath(slug)}/.playground/seed-data.json`;
	return {
		step: 'runPHP',
		code: `<?php require_once '${WP_ROOT}/wp-load.php'; if ( function_exists( 'playground_seed_products' ) ) { $p = '${dataPath}'; playground_seed_tax_classes($p); playground_seed_tax_rates($p); playground_seed_product_attributes($p); playground_seed_products($p); playground_seed_coupons($p); playground_seed_shipping_zones($p); playground_seed_user_billing(1, $p); playground_seed_orders($p); }`,
	};
}

/**
 * The demo/e2e fixture: one simple product and three orders in different
 * statuses for customer 1.
 *
 * @return {Object[]} Fixture steps.
 */
export function demoFixture() {
	return [
		{
			step: 'wp-cli',
			command:
				"wp wc product create --name='Simple product' --sku='simple-product' --regular_price='99.99' --virtual=false --downloadable=false --user=1",
		},
		{
			step: 'runPHP',
			code: `<?php\nrequire_once '${WP_ROOT}/wp-load.php';\nif ( ! function_exists( 'wc_create_order' ) ) {\n  return;\n}\n$product = wc_get_product( wc_get_product_id_by_sku( 'simple-product' ) );\nif ( ! $product ) {\n  return;\n}\n$statuses = array( 'completed', 'processing', 'refunded' );\nforeach ( $statuses as $status ) {\n  $order = wc_create_order( array( 'customer_id' => 1 ) );\n  if ( is_wp_error( $order ) ) {\n    continue;\n  }\n  $order->add_product( $product, 1 );\n  $order->set_address(\n    array(\n      'first_name' => 'Test',\n      'last_name'  => 'Customer',\n      'address_1'  => 'Test Road 1',\n      'city'       => 'Arvika',\n      'postcode'   => '67131',\n      'country'    => 'SE',\n      'email'      => 'test@example.com',\n    ),\n    'billing'\n  );\n  $order->calculate_totals();\n  $order->update_status( $status );\n  $order->save();\n}`,
		},
	];
}
