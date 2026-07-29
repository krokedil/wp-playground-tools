/**
 * Fixture config mirroring returns-and-withdrawals' real setup. The parity
 * tests compose blueprints from this and compare them against the plugin's
 * previously committed blueprints (tests/fixtures/rwwc-*.json).
 */
const RWWC_OPTIONS = {
	rwwc_enable_returns: 'yes',
	rwwc_enable_withdrawals: 'yes',
	rwwc_return_available_days: '30',
	rwwc_activate_exclude_products: 'yes',
	rwwc_activate_free_shipping_coupon: 'yes',
	rwwc_free_shipping_coupon_days: '14',
	rwwc_offer_return_shipment: 'yes',
	rwwc_return_shipment_price: '49',
	rwwc_repay_shipping_cost: 'yes_full_return',
	rwwc_return_order_number_prefix: '-R',
	rwwc_completed_return_parent_order_status: 'no',
};

export default {
	slug: 'returns-and-withdrawals',
	siteName: 'Returns and Withdrawals',
	landingPage: '/returns/',
	basePort: 8880,
	composer: {
		markers: ['vendor/autoload.php', 'dependencies/autoload.php'],
	},
	build: {
		markers: [
			'blocks/build/returns.asset.php',
			'blocks/build/withdrawal.asset.php',
		],
		command: 'build',
	},
	options: { all: RWWC_OPTIONS },
	pages: {
		development: [
			{
				title: 'Returns',
				slug: 'returns',
				content:
					'<!-- wp:shortcode -->[rwwc_dev_orders]<!-- /wp:shortcode --><!-- wp:rwwc/return /-->',
			},
			{
				title: 'Withdrawals',
				slug: 'withdrawals',
				content:
					'<!-- wp:shortcode -->[rwwc_dev_orders]<!-- /wp:shortcode --><!-- wp:rwwc/withdrawal /-->',
			},
		],
		demo: [
			{
				title: 'Returns',
				slug: 'returns',
				content: '<!-- wp:rwwc/return /-->',
			},
		],
		e2e: [
			{
				title: 'Returns',
				slug: 'returns',
				content: '<!-- wp:rwwc/return /-->',
			},
		],
	},
	muPlugins: {
		development: ['tools/blueprints/development/rwwc-dev-helper.php'],
	},
	seedData: 'tools/blueprints/development/playground-seeder-data.json',
	modes: ['start', 'development', 'demo', 'e2e'],
	screenshots: './tools/screenshots/shots.config.mjs',
};
