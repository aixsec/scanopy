#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Consolidate duplicate i18n keys into common_ keys
 */

const fs = require('fs');
const path = require('path');

const MESSAGES_PATH = path.join(__dirname, '../../messages/en.json');
const SRC_PATH = path.join(__dirname, '../src');

// Define consolidations: { newKey: { value: string, oldKeys: string[] } }
const CONSOLIDATIONS = {
	// Remove duplicate - keep common_networks
	common_networks: {
		value: 'Networks',
		oldKeys: ['common_networksLabel']
	},
	// Edit {name} pattern
	common_editName: {
		value: 'Edit {name}',
		oldKeys: [
			'daemonApiKeys_editApiKey',
			'groups_editGroup',
			'hosts_editHost',
			'networks_editNetwork',
			'shares_editShare',
			'subnets_editSubnet',
			'tags_editTag',
			'topology_editTopology',
			'userApiKeys_editApiKey'
		]
	},
	// API Key related
	common_enableApiKey: {
		value: 'Enable API Key',
		oldKeys: ['daemonApiKeys_enableApiKey', 'userApiKeys_enableApiKey']
	},
	common_expirationDateOptional: {
		value: 'Expiration Date (Optional)',
		oldKeys: ['daemonApiKeys_expirationDate', 'userApiKeys_expirationDate']
	},
	common_expirationNeverHelp: {
		value: 'Leave empty for keys that never expire',
		oldKeys: ['daemonApiKeys_expirationDateHelp', 'userApiKeys_expirationHelp']
	},
	common_failedGenerateApiKey: {
		value: 'Failed to generate API key',
		oldKeys: [
			'daemonApiKeys_failedGenerate',
			'daemons_failedGenerateKey',
			'userApiKeys_failedGenerate'
		]
	},
	common_failedRotateApiKey: {
		value: 'Failed to rotate API key',
		oldKeys: ['daemonApiKeys_failedRotate', 'userApiKeys_failedRotate']
	},
	common_keyDetails: {
		value: 'Key Details',
		oldKeys: ['daemonApiKeys_keyDetails', 'userApiKeys_keyDetails']
	},
	common_apiKeyNameHelp: {
		value: 'A friendly name to help you identify this key',
		oldKeys: ['daemonApiKeys_nameHelp', 'userApiKeys_nameHelp']
	},
	common_generateKey: {
		value: 'Generate Key',
		oldKeys: ['apiKeys_generateKey', 'daemons_generateKey']
	},
	common_pressGenerateKey: {
		value: 'Press Generate Key...',
		oldKeys: ['apiKeys_pressGenerate', 'daemons_pressGenerateKey']
	},
	// Confirmation dialogs
	common_confirmDeleteName: {
		value: 'Are you sure you want to delete "{name}"?',
		oldKeys: [
			'discovery_confirmDeleteSingle',
			'groups_confirmDelete',
			'hosts_confirmDelete',
			'shares_confirmDelete',
			'subnets_confirmDelete',
			'tags_confirmDelete'
		]
	},
	// Common fields
	common_ipAddress: {
		value: 'IP Address',
		oldKeys: ['discovery_ipAddress', 'hosts_interfaces_ipAddress']
	},
	common_noTypeSpecified: {
		value: 'No type specified',
		oldKeys: ['groups_noTypeSpecified', 'subnets_noTypeSpecified']
	},
	// Keep one of the duplicates
	hosts_consolidateModal_title: {
		value: 'Consolidate Hosts',
		oldKeys: ['hosts_consolidateModal_consolidateHosts']
	},
	hosts_interfaces_deleteTitle: {
		value: 'Delete Interface',
		oldKeys: ['hosts_interfaces_deleteConfirm']
	},
	hosts_ports_deleteTitle: {
		value: 'Delete Port',
		oldKeys: ['hosts_ports_deleteConfirm']
	},
	// Bindings
	common_interfaceBindings: {
		value: 'Interface Bindings',
		oldKeys: ['hosts_services_interfaceBindings', 'services_interfaceBindings']
	},
	common_portBindings: {
		value: 'Port Bindings',
		oldKeys: ['hosts_services_portBindings', 'services_portBindings']
	},
	// Other common
	common_noServiceSelected: {
		value: 'No service selected',
		oldKeys: ['hosts_services_noSelected', 'hosts_virtualization_noSelected']
	},
	common_userId: {
		value: 'User ID',
		oldKeys: ['support_userId', 'settings_account_userId']
	},
	common_emailAndPassword: {
		value: 'Email & Password',
		oldKeys: ['settings_account_emailPassword', 'users_emailAndPassword']
	},
	common_tryAgainLater: {
		value: 'Please try again later',
		oldKeys: ['settings_billing_tryAgainLater', 'settings_org_tryAgainLater']
	}
};

function findFilesRecursively(dir, extensions) {
	const files = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.svelte-kit') {
			files.push(...findFilesRecursively(fullPath, extensions));
		} else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
			files.push(fullPath);
		}
	}

	return files;
}

function main() {
	const dryRun = process.argv.includes('--dry-run');

	// Read messages
	const messages = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));

	// Find source files
	const sourceFiles = findFilesRecursively(SRC_PATH, ['.svelte', '.ts']);

	let totalReplacements = 0;
	let keysToDelete = [];

	for (const [newKey, config] of Object.entries(CONSOLIDATIONS)) {
		const { value, oldKeys } = config;

		// Add new key if it doesn't exist
		if (!(newKey in messages)) {
			console.log(`Adding new key: ${newKey} = "${value}"`);
			if (!dryRun) {
				messages[newKey] = value;
			}
		}

		// Replace usages in source files
		for (const oldKey of oldKeys) {
			if (!(oldKey in messages)) {
				continue; // Already deleted or doesn't exist
			}

			const oldPattern = `m.${oldKey}(`;
			const newPattern = `m.${newKey}(`;

			for (const filePath of sourceFiles) {
				let content = fs.readFileSync(filePath, 'utf8');

				if (content.includes(oldPattern)) {
					const count = (
						content.match(new RegExp(oldPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []
					).length;
					console.log(
						`  Replacing ${oldKey} -> ${newKey} in ${path.relative(SRC_PATH, filePath)} (${count} occurrences)`
					);
					totalReplacements += count;

					if (!dryRun) {
						content = content.split(oldPattern).join(newPattern);
						fs.writeFileSync(filePath, content);
					}
				}
			}

			keysToDelete.push(oldKey);
		}
	}

	// Delete old keys
	console.log(`\nDeleting ${keysToDelete.length} old keys...`);
	for (const key of keysToDelete) {
		if (key in messages) {
			if (!dryRun) {
				delete messages[key];
			}
		}
	}

	// Write messages
	if (!dryRun) {
		// Sort keys
		const sorted = {};
		for (const key of Object.keys(messages).sort()) {
			sorted[key] = messages[key];
		}
		fs.writeFileSync(MESSAGES_PATH, JSON.stringify(sorted, null, '\t') + '\n');
	}

	console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Summary:`);
	console.log(`  Total replacements: ${totalReplacements}`);
	console.log(`  Keys deleted: ${keysToDelete.length}`);
	console.log(`  Keys remaining: ${Object.keys(messages).length - keysToDelete.length}`);
}

main();
