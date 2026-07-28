<?php
/**
 * Plugin Name: Krokedil Dev Orders Panel
 * Description: Lists seeded test orders with prefill/view/trash actions and a template-driven "generate order" button. Part of @krokedil/wp-playground-tools; staged by the development blueprint.
 *
 * Renders via the [krokedil_dev_orders] shortcode: a yellow dev panel listing
 * the 10 most recent shop orders with Prefill / View frontend / View backend /
 * Trash actions, plus a dropdown of the order templates in the staged
 * seed-data.json creating one per click (via playground-seeder.php's
 * playground_create_order_from_template()).
 *
 * Plugin-specific wiring happens through one filter:
 *
 *   add_filter( 'krokedil_pg_dev_panel_prefill', fn() => array(
 *       'order' => 'rwwc-order',   // input[name=…] to receive the order number
 *       'email' => 'rwwc-email',   // input[name=…] to receive the billing email
 *   ) );
 *
 * Without the filter the Prefill button is hidden and the panel is always
 * shown; with it, the panel also auto-hides once those GET params are present
 * (the tester has searched and the list is just noise). Declare the filter in
 * a small plugin-local mu-plugin listed in config.muPlugins.
 *
 * Dev-only tool: renders exclusively for logged-in shop managers, and is
 * never part of a released plugin (staged under .playground/, git-ignored).
 *
 * @package Krokedil\WpPlaygroundTools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Absolute path to the staged seed-data JSON. __DIR__ resolves through the
 * mu-plugins symlink to .playground/mu-plugins/, so the data sits one level up.
 *
 * @return string
 */
function krokedil_pg_seed_data_path() {
	return dirname( __DIR__ ) . '/seed-data.json';
}

/**
 * The plugin's prefill field map, or an empty array when not declared.
 *
 * @return array{order?: string, email?: string}
 */
function krokedil_pg_dev_panel_prefill_fields() {
	$fields = apply_filters( 'krokedil_pg_dev_panel_prefill', array() );
	return is_array( $fields ) ? $fields : array();
}

/**
 * Build the wp-admin edit URL for an order, accounting for HPOS when enabled.
 *
 * @param int $order_id Order ID.
 * @return string
 */
function krokedil_pg_admin_edit_order_url( $order_id ) {
	if (
		class_exists( '\Automattic\WooCommerce\Utilities\OrderUtil' )
		&& \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled()
	) {
		return admin_url( 'admin.php?page=wc-orders&action=edit&id=' . $order_id );
	}
	return admin_url( 'post.php?post=' . $order_id . '&action=edit' );
}

/**
 * Render the dev orders panel.
 *
 * @return string
 */
function krokedil_pg_render_orders_panel() {
	if ( ! function_exists( 'wc_get_orders' ) ) {
		return '';
	}

	// Dev-only tool — never render for anonymous visitors or non-shop-managers.
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return '';
	}

	// With prefill wired, hide the panel once the plugin's search form has been
	// submitted — the tester is past the list at that point.
	$prefill = krokedil_pg_dev_panel_prefill_fields();
	if (
		! empty( $prefill['order'] ) && ! empty( $prefill['email'] )
		&& ! empty( $_GET[ $prefill['order'] ] ) && ! empty( $_GET[ $prefill['email'] ] ) // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	) {
		return '';
	}

	$orders = wc_get_orders(
		array(
			'limit'   => 10,
			'orderby' => 'date',
			'order'   => 'DESC',
			'type'    => 'shop_order',
		)
	);

	$page_url     = get_permalink();
	$generate_url = admin_url( 'admin-post.php' );

	// Templates the tester can choose from when generating a new order.
	$templates = function_exists( 'playground_seed_data' )
		? ( playground_seed_data( krokedil_pg_seed_data_path() )['orders'] ?? array() )
		: array();

	// Print the panel's CSS only once per request, even if the shortcode renders multiple times.
	static $style_printed = false;

	ob_start();
	if ( ! $style_printed ) :
		$style_printed = true;
		?>
		<style>
		.krokedil-dev-orders { border:1px dashed #888; padding:1em; margin-bottom:1em; background:#fffbe6; font-size:0.95em; }
		.krokedil-dev-orders__title { margin:0 0 0.25em; font-size:1.4em; }
		.krokedil-dev-orders__subtitle { margin:0 0 0.25em; font-size:1.15em; }
		.krokedil-dev-orders__subtitle--spaced { margin-top:1.5em; }
		.krokedil-dev-orders__intro, .krokedil-dev-orders__desc { font-size:0.9em; color:#555; }
		.krokedil-dev-orders__intro { margin:0 0 1em; }
		.krokedil-dev-orders__desc { margin:0 0 0.5em; }
		.krokedil-dev-orders__field { margin-bottom:0.5em; }
		.krokedil-dev-orders__delete-form { display:inline; }
		.krokedil-dev-orders a.button { text-decoration:none; }
		.krokedil-dev-orders a.button, .krokedil-dev-orders button.button { font-size:0.9em; padding:0.3em 0.7em; line-height:1.4; }
		</style>
		<?php
	endif;
	?>
	<div class="krokedil-dev-orders">
		<h2 class="krokedil-dev-orders__title"><?php echo esc_html( 'Dev Helper' ); ?></h2>
		<p class="krokedil-dev-orders__intro">
			<?php echo esc_html( 'This panel only exists on the local Playground site — it is not part of the released plugin.' ); ?>
		</p>
		<h3 class="krokedil-dev-orders__subtitle"><?php echo esc_html( 'List of existing orders' ); ?></h3>
		<?php if ( ! empty( $prefill['order'] ) ) : ?>
			<p class="krokedil-dev-orders__desc">
				<?php echo esc_html( 'Use Prefill to populate the search form below, then press Search.' ); ?>
			</p>
		<?php endif; ?>
		<?php if ( empty( $orders ) ) : ?>
			<p><?php echo esc_html( 'No test orders yet. Click the button below to generate one.' ); ?></p>
		<?php else : ?>
			<table class="shop_table shop_table_responsive my_account_orders woocommerce-orders-table">
				<thead>
					<tr>
						<th class="woocommerce-orders-table__header"><?php echo esc_html( 'Order' ); ?></th>
						<th class="woocommerce-orders-table__header"><?php echo esc_html( 'Email' ); ?></th>
						<th class="woocommerce-orders-table__header"><?php echo esc_html( 'Status' ); ?></th>
						<th class="woocommerce-orders-table__header"><?php echo esc_html( 'Actions' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ( $orders as $dev_order ) : ?>
						<?php
						$order_id     = $dev_order->get_id();
						$order_number = $dev_order->get_order_number();
						$email        = $dev_order->get_billing_email();
						$frontend_url = $dev_order->get_view_order_url();
						$backend_url  = krokedil_pg_admin_edit_order_url( $order_id );
						?>
						<tr class="woocommerce-orders-table__row">
							<td class="woocommerce-orders-table__cell" data-title="Order">
								#<?php echo esc_html( $order_number ); ?>
							</td>
							<td class="woocommerce-orders-table__cell" data-title="Email">
								<?php echo esc_html( $email ); ?>
							</td>
							<td class="woocommerce-orders-table__cell" data-title="Status">
								<?php echo esc_html( wc_get_order_status_name( $dev_order->get_status() ) ); ?>
							</td>
							<td class="woocommerce-orders-table__cell" data-title="Actions">
								<?php if ( ! empty( $prefill['order'] ) ) : ?>
									<button type="button" class="button krokedil-pg-prefill"
										data-order="<?php echo esc_attr( $order_number ); ?>"
										data-email="<?php echo esc_attr( $email ); ?>">
										<?php echo esc_html( 'Prefill' ); ?>
									</button>
								<?php endif; ?>
								<a class="button" href="<?php echo esc_url( $frontend_url ); ?>">
									<?php echo esc_html( 'View frontend' ); ?>
								</a>
								<a class="button" href="<?php echo esc_url( $backend_url ); ?>">
									<?php echo esc_html( 'View backend' ); ?>
								</a>
								<form method="post" action="<?php echo esc_url( $generate_url ); ?>" class="krokedil-dev-orders__delete-form">
									<input type="hidden" name="action" value="krokedil_pg_delete_order">
									<input type="hidden" name="order_id" value="<?php echo esc_attr( $order_id ); ?>">
									<input type="hidden" name="redirect_to" value="<?php echo esc_url( $page_url ); ?>">
									<?php wp_nonce_field( 'krokedil_pg_delete_order' ); ?>
									<button type="submit" class="button"><?php echo esc_html( 'Trash' ); ?></button>
								</form>
							</td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>
		<h3 class="krokedil-dev-orders__subtitle krokedil-dev-orders__subtitle--spaced"><?php echo esc_html( 'Create new test orders' ); ?></h3>
		<p class="krokedil-dev-orders__desc">
			<?php echo esc_html( 'Choose what type of test order you want to create from the drop down below.' ); ?>
		</p>
		<form method="post" action="<?php echo esc_url( $generate_url ); ?>">
			<input type="hidden" name="action" value="krokedil_pg_generate_order">
			<input type="hidden" name="redirect_to" value="<?php echo esc_url( $page_url ); ?>">
			<?php wp_nonce_field( 'krokedil_pg_generate_order' ); ?>
			<?php if ( ! empty( $templates ) ) : ?>
				<div class="krokedil-dev-orders__field">
					<label for="krokedil-pg-template"><?php echo esc_html( 'Available order templates:' ); ?></label>
					<select name="template" id="krokedil-pg-template">
						<?php foreach ( $templates as $index => $template ) : ?>
							<option value="<?php echo esc_attr( $index ); ?>">
								<?php echo esc_html( ! empty( $template['label'] ) ? $template['label'] : 'Template ' . $index ); ?>
							</option>
						<?php endforeach; ?>
					</select>
				</div>
			<?php endif; ?>
			<div>
				<button type="submit" class="button"><?php echo esc_html( 'Generate new test order' ); ?></button>
			</div>
		</form>
	</div>
	<?php if ( ! empty( $prefill['order'] ) ) : ?>
	<script>
	(function () {
		var fields = <?php echo wp_json_encode( $prefill ); ?>;
		document.querySelectorAll('.krokedil-pg-prefill').forEach(function (btn) {
			btn.addEventListener('click', function () {
				var orderField = fields.order ? document.querySelector('input[name="' + fields.order + '"]') : null;
				var emailField = fields.email ? document.querySelector('input[name="' + fields.email + '"]') : null;
				if (orderField) { orderField.value = btn.dataset.order; orderField.focus(); }
				if (emailField) { emailField.value = btn.dataset.email; }
			});
		});
	})();
	</script>
	<?php endif; ?>
	<?php
	return ob_get_clean();
}
add_shortcode( 'krokedil_dev_orders', 'krokedil_pg_render_orders_panel' );

/**
 * Handle the "Generate new test order" form submission. Creates the selected
 * template (an index into seed-data.json's "orders"), falling back to the
 * first template when the posted index is missing or out of range.
 *
 * @return void
 */
function krokedil_pg_generate_order() {
	check_admin_referer( 'krokedil_pg_generate_order' );

	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		wp_die( 'You do not have permission to generate test orders.', '', array( 'response' => 403 ) );
	}

	if (
		function_exists( 'playground_seed_data' )
		&& function_exists( 'playground_create_order_from_template' )
	) {
		$path      = krokedil_pg_seed_data_path();
		$templates = playground_seed_data( $path )['orders'] ?? array();
		if ( ! empty( $templates ) ) {
			$index = isset( $_POST['template'] ) ? absint( wp_unslash( $_POST['template'] ) ) : 0;
			if ( ! isset( $templates[ $index ] ) ) {
				$index = 0; // Out-of-range / missing → first template.
			}
			playground_create_order_from_template( $templates[ $index ], $path );
		}
	}

	$redirect = isset( $_POST['redirect_to'] ) ? esc_url_raw( wp_unslash( $_POST['redirect_to'] ) ) : home_url( '/' );
	wp_safe_redirect( $redirect );
	exit;
}
add_action( 'admin_post_krokedil_pg_generate_order', 'krokedil_pg_generate_order' );

/**
 * Handle the per-row "Trash" button. Trashes (not force-deletes) the order so
 * it drops out of the panel while staying recoverable in wp-admin.
 *
 * @return void
 */
function krokedil_pg_delete_order() {
	check_admin_referer( 'krokedil_pg_delete_order' );

	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		wp_die( 'You do not have permission to delete test orders.', '', array( 'response' => 403 ) );
	}

	$order_id = isset( $_POST['order_id'] ) ? absint( wp_unslash( $_POST['order_id'] ) ) : 0;
	$order    = $order_id ? wc_get_order( $order_id ) : false;
	if ( $order ) {
		$order->delete( false ); // Trash (force = false); HPOS-safe and recoverable.
	}

	$redirect = isset( $_POST['redirect_to'] ) ? esc_url_raw( wp_unslash( $_POST['redirect_to'] ) ) : home_url( '/' );
	wp_safe_redirect( $redirect );
	exit;
}
add_action( 'admin_post_krokedil_pg_delete_order', 'krokedil_pg_delete_order' );
