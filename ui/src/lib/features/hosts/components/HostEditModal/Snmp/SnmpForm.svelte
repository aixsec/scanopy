<script lang="ts">
	import type { HostFormData } from '$lib/features/hosts/types/base';
	import type { Network } from '$lib/features/networks/types';
	import RichSelect from '$lib/shared/components/forms/selection/RichSelect.svelte';
	import { useSnmpCredentialsQuery } from '$lib/features/snmp/queries';
	import { SnmpCredentialDisplay } from '$lib/shared/components/forms/selection/display/SnmpCredentialDisplay.svelte';
	import { useOrganizationQuery } from '$lib/features/organizations/queries';
	import { useCurrentUserQuery } from '$lib/features/auth/queries';

	interface Props {
		formData: HostFormData;
		isEditing: boolean;
		network?: Network | null;
	}

	let { formData = $bindable(), isEditing, network = null }: Props = $props();

	// TanStack Query for organization and current user (for demo mode check)
	const organizationQuery = useOrganizationQuery();
	let organization = $derived(organizationQuery.data);

	const currentUserQuery = useCurrentUserQuery();
	let currentUser = $derived(currentUserQuery.data);

	// Demo mode check: only Owner can modify SNMP settings in demo orgs
	let isDemoOrg = $derived(organization?.plan?.type === 'Demo');
	let isNonOwnerInDemo = $derived(isDemoOrg && currentUser?.permissions !== 'Owner');

	// TanStack Query for SNMP credentials
	const snmpCredentialsQuery = useSnmpCredentialsQuery();
	let snmpCredentials = $derived(snmpCredentialsQuery.data ?? []);

	// Get the network's default credential name for display
	let networkCredentialName = $derived(() => {
		if (!network?.snmp_credential_id) return 'None';
		const cred = snmpCredentials.find((c) => c.id === network.snmp_credential_id);
		return cred?.name ?? 'Unknown';
	});

	// Check if we have SNMP data to display
	let hasSnmpData = $derived(
		formData.sys_descr ||
			formData.sys_object_id ||
			formData.sys_location ||
			formData.sys_contact ||
			formData.chassis_id ||
			formData.management_url
	);
</script>

<div class="space-y-6 p-6">
	<!-- Credential Override Section -->
	<div class="space-y-4">
		<h3 class="text-primary text-lg font-medium">SNMP Credential</h3>

		<div class="bg-tertiary/30 mb-4 rounded-lg p-4">
			<p class="text-muted text-sm">
				Network default: <span class="text-secondary font-medium">{networkCredentialName()}</span>
			</p>
			<p class="text-muted mt-1 text-xs">
				Select a credential below to override the network default for this host.
			</p>
		</div>

		<RichSelect
			label="SNMP Credential Override"
			placeholder="Use network default"
			required={false}
			selectedValue={formData.snmp_credential_id}
			options={snmpCredentials}
			displayComponent={SnmpCredentialDisplay}
			onSelect={(id) => (formData.snmp_credential_id = id)}
			disabled={isNonOwnerInDemo}
		/>
		{#if isNonOwnerInDemo}
			<p class="text-muted mt-1 text-xs">SNMP settings are read-only in demo mode.</p>
		{/if}
	</div>

	<!-- SNMP System Information (read-only, only shown when editing with data) -->
	{#if isEditing && hasSnmpData}
		<div class="space-y-4">
			<h3 class="text-primary text-lg font-medium">SNMP System Information</h3>
			<p class="text-muted text-sm">
				These values are populated by SNMP discovery and are read-only.
			</p>

			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				{#if formData.sys_descr}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>System Description</span
						>
						<p class="text-primary mt-1 break-words text-sm">{formData.sys_descr}</p>
					</div>
				{/if}

				{#if formData.sys_object_id}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>System OID</span
						>
						<p class="text-primary mt-1 font-mono text-sm">{formData.sys_object_id}</p>
					</div>
				{/if}

				{#if formData.sys_location}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>Location</span
						>
						<p class="text-primary mt-1 text-sm">{formData.sys_location}</p>
					</div>
				{/if}

				{#if formData.sys_contact}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>Contact</span
						>
						<p class="text-primary mt-1 text-sm">{formData.sys_contact}</p>
					</div>
				{/if}

				{#if formData.chassis_id}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>Chassis ID</span
						>
						<p class="text-primary mt-1 font-mono text-sm">{formData.chassis_id}</p>
					</div>
				{/if}

				{#if formData.management_url}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium uppercase tracking-wide"
							>Management URL</span
						>
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={formData.management_url}
							target="_blank"
							rel="external noopener noreferrer"
							class="mt-1 break-all text-sm text-blue-400 hover:text-blue-300"
						>
							{formData.management_url}
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if !isEditing}
		<div class="bg-tertiary/30 rounded-lg p-4">
			<p class="text-muted text-sm">
				SNMP system information will be populated after the host is created and discovered via SNMP.
			</p>
		</div>
	{/if}
</div>
