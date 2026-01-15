#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Delete unused i18n keys from en.json
 *
 * Usage:
 *   node scripts/delete-unused-i18n-keys.js key1 key2 key3
 *   node scripts/delete-unused-i18n-keys.js --dry-run key1 key2 key3
 *   echo "key1\nkey2" | node scripts/delete-unused-i18n-keys.js --stdin
 */

const fs = require('fs');
const path = require('path');

const MESSAGES_PATH = path.join(__dirname, '../../messages/en.json');

function main() {
	const args = process.argv.slice(2);

	let dryRun = false;
	let useStdin = false;
	let keys = [];

	for (const arg of args) {
		if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg === '--stdin') {
			useStdin = true;
		} else if (arg.startsWith('-')) {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		} else {
			keys.push(arg);
		}
	}

	if (useStdin) {
		const input = fs.readFileSync(0, 'utf8');
		// Parse keys from input - handle "  - keyName" format from test output
		const stdinKeys = input
			.split('\n')
			.map((line) => line.trim())
			.map((line) => line.replace(/^-\s*/, '')) // Remove leading "- "
			.filter(
				(line) =>
					line && !line.includes(' ') && !line.startsWith('Found') && !line.startsWith('Remove')
			);
		keys.push(...stdinKeys);
	}

	if (keys.length === 0) {
		console.error('No keys provided. Usage:');
		console.error('  node scripts/delete-unused-i18n-keys.js key1 key2 key3');
		console.error('  node scripts/delete-unused-i18n-keys.js --dry-run key1 key2');
		console.error('  echo "key1\\nkey2" | node scripts/delete-unused-i18n-keys.js --stdin');
		process.exit(1);
	}

	// Read current messages
	const messages = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
	const originalCount = Object.keys(messages).length;

	// Find which keys exist
	const keysToDelete = keys.filter((key) => key in messages);
	const keysNotFound = keys.filter((key) => !(key in messages));

	console.log(`\nMessages file: ${MESSAGES_PATH}`);
	console.log(`Total keys in file: ${originalCount}`);
	console.log(`Keys requested for deletion: ${keys.length}`);
	console.log(`Keys found and will be deleted: ${keysToDelete.length}`);

	if (keysNotFound.length > 0) {
		console.log(`Keys not found (skipped): ${keysNotFound.length}`);
	}

	if (keysToDelete.length === 0) {
		console.log('\nNo keys to delete.');
		process.exit(0);
	}

	// Safety check - don't delete more than 50% of keys
	const deletePercentage = (keysToDelete.length / originalCount) * 100;
	if (deletePercentage > 50) {
		console.error(
			`\nSAFETY CHECK FAILED: Attempting to delete ${deletePercentage.toFixed(1)}% of all keys.`
		);
		console.error('This script refuses to delete more than 50% of keys as a safety measure.');
		process.exit(1);
	}

	console.log(`\nKeys to delete (${keysToDelete.length}):`);
	for (const key of keysToDelete.slice(0, 10)) {
		console.log(`  - ${key}`);
	}
	if (keysToDelete.length > 10) {
		console.log(`  ... and ${keysToDelete.length - 10} more`);
	}

	if (dryRun) {
		console.log('\n[DRY RUN] No changes made.');
		console.log(
			`Would delete ${keysToDelete.length} keys, leaving ${originalCount - keysToDelete.length} keys.`
		);
		process.exit(0);
	}

	// Delete keys
	for (const key of keysToDelete) {
		delete messages[key];
	}

	// Write back
	fs.writeFileSync(MESSAGES_PATH, JSON.stringify(messages, null, '\t') + '\n');

	const newCount = Object.keys(messages).length;
	console.log(`\nDeleted ${keysToDelete.length} keys.`);
	console.log(`Keys remaining: ${newCount}`);
}

main();
