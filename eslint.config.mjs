// @ts-nocheck
import { defineConfig, globalIgnores } from 'eslint/config';
import wordpress from '@wordpress/eslint-plugin';

export default defineConfig([
	...wordpress.configs.recommended,
	// Mirror .prettierignore. `.claude/worktrees/` holds nested checkouts of
	// this repo; the path-relative rules above miss their copies.
	globalIgnores([
		'**/node_modules/',
		'**/assets/',
		'src/init/templates/',
		'.claude/worktrees/',
	]),
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
