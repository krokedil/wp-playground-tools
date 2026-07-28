// @ts-nocheck
import { defineConfig, globalIgnores } from 'eslint/config';
import wordpress from '@wordpress/eslint-plugin';

export default defineConfig([
	...wordpress.configs.recommended,
	globalIgnores(['**/node_modules/', '**/assets/', 'src/init/templates/']),
	{
		rules: {
			'jsdoc/require-param-description': 'error',
			'jsdoc/require-returns-description': 'error',
			'jsdoc/valid-types': 'error',
			// The CLI talks to the terminal by design.
			'no-console': 'off',
		},
	},
]);
