import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findFilesRecursively(dir: string, extensions: string[]): string[] {
	const files: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'tests') {
			files.push(...findFilesRecursively(fullPath, extensions));
		} else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
			files.push(fullPath);
		}
	}

	return files;
}

describe('i18n prop defaults', () => {
	it('should not use m.* calls directly in export let default values', () => {
		// This pattern breaks in production builds due to Svelte 5 + bundler tree-shaking.
		// The @__NO_SIDE_EFFECTS__ annotation on paraglide message functions causes the
		// bundler to remove these calls when used only as default values, resulting in
		// "(void 0) is not a function" errors at runtime.
		//
		// BAD:  export let message: string = m.common_loading();
		// GOOD: export let message: string | undefined = undefined;
		//       $: displayMessage = message ?? m.common_loading();

		const srcPath = path.resolve(__dirname, '..');
		const svelteFiles = findFilesRecursively(srcPath, ['.svelte']);

		// Pattern: export let <name>: <type> = m.<function>(
		// This catches direct message function calls in prop defaults
		const badPattern = /export\s+let\s+(\w+)\s*:\s*[^=]+=\s*m\.(\w+)\s*\(/g;

		const violations: { file: string; prop: string; messageFunc: string; line: number }[] = [];

		for (const file of svelteFiles) {
			const content = fs.readFileSync(file, 'utf8');
			const lines = content.split('\n');

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const matches = [...line.matchAll(badPattern)];

				for (const match of matches) {
					violations.push({
						file: path.relative(srcPath, file),
						prop: match[1],
						messageFunc: match[2],
						line: i + 1
					});
				}
			}
		}

		if (violations.length > 0) {
			const lines = violations.map(
				(v) => `  - ${v.file}:${v.line}\n    prop "${v.prop}" uses m.${v.messageFunc}() as default`
			);
			const message = `Found ${violations.length} Svelte props using m.* calls as default values:

${lines.join('\n')}

This pattern breaks in production builds. Instead, use:
  export let prop: string | undefined = undefined;
  $: displayProp = prop ?? m.message_key();

Or handle the default in the template with ?? operator.`;
			expect.fail(message);
		}
	});
});
