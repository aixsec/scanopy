<script lang="ts">
	import {
		useSnmpCredentialsQuery,
		useCreateSnmpCredentialMutation,
		useUpdateSnmpCredentialMutation,
		useDeleteSnmpCredentialMutation,
		useBulkDeleteSnmpCredentialsMutation
	} from '../queries';
	import SnmpCredentialCard from './SnmpCredentialCard.svelte';
	import SnmpCredentialEditModal from './SnmpCredentialEditModal.svelte';
	import TabHeader from '$lib/shared/components/layout/TabHeader.svelte';
	import Loading from '$lib/shared/components/feedback/Loading.svelte';
	import EmptyState from '$lib/shared/components/layout/EmptyState.svelte';
	import type { SnmpCredential } from '../types/base';
	import DataControls from '$lib/shared/components/data/DataControls.svelte';
	import { defineFields } from '$lib/shared/components/data/types';
	import { Plus } from 'lucide-svelte';
	import { useCurrentUserQuery } from '$lib/features/auth/queries';
	import { useOrganizationQuery } from '$lib/features/organizations/queries';
	import { permissions } from '$lib/shared/stores/metadata';
	import type { TabProps } from '$lib/shared/types';
	import type { components } from '$lib/api/schema';
	import {
		common_confirmDeleteName,
		common_create,
		common_created,
		common_name,
		common_updated,
		common_version
	} from '$lib/paraglide/messages';

	type SnmpCredentialOrderField = components['schemas']['SnmpCredentialOrderField'];

	let { isReadOnly = false }: TabProps = $props();

	let showCredentialEditor = $state(false);
	let editingCredential: SnmpCredential | null = $state(null);

	// Queries and mutations
	const currentUserQuery = useCurrentUserQuery();
	let currentUser = $derived(currentUserQuery.data);

	const organizationQuery = useOrganizationQuery();
	let organization = $derived(organizationQuery.data);

	const credentialsQuery = useSnmpCredentialsQuery();
	const createCredentialMutation = useCreateSnmpCredentialMutation();
	const updateCredentialMutation = useUpdateSnmpCredentialMutation();
	const deleteCredentialMutation = useDeleteSnmpCredentialMutation();
	const bulkDeleteCredentialsMutation = useBulkDeleteSnmpCredentialsMutation();

	// Derived state
	let credentials = $derived(credentialsQuery.data ?? []);
	let isLoading = $derived(credentialsQuery.isLoading);

	// Demo mode check: only Owner can manage SNMP credentials in demo orgs
	let isDemoOrg = $derived(organization?.plan?.type === 'Demo');
	let isNonOwnerInDemo = $derived(isDemoOrg && currentUser?.permissions !== 'Owner');

	let canManage = $derived(
		!isReadOnly &&
			!isNonOwnerInDemo &&
			currentUser &&
			permissions.getMetadata(currentUser.permissions).manage_org_entities
	);

	let allowBulkDelete = $derived(
		!isReadOnly && !isNonOwnerInDemo && currentUser
			? permissions.getMetadata(currentUser.permissions).manage_org_entities
			: false
	);

	function handleCreateCredential() {
		editingCredential = null;
		showCredentialEditor = true;
	}

	function handleEditCredential(credential: SnmpCredential) {
		editingCredential = credential;
		showCredentialEditor = true;
	}

	async function handleDeleteCredential(credential: SnmpCredential) {
		if (confirm(common_confirmDeleteName({ name: credential.name }))) {
			await deleteCredentialMutation.mutateAsync(credential.id);
		}
	}

	async function handleCredentialCreate(data: SnmpCredential) {
		await createCredentialMutation.mutateAsync(data);
		showCredentialEditor = false;
		editingCredential = null;
	}

	async function handleCredentialUpdate(_id: string, data: SnmpCredential) {
		await updateCredentialMutation.mutateAsync(data);
		showCredentialEditor = false;
		editingCredential = null;
	}

	function handleCloseCredentialEditor() {
		showCredentialEditor = false;
		editingCredential = null;
	}

	async function handleBulkDelete(ids: string[]) {
		if (confirm(`Delete ${ids.length} SNMP credential(s)? This cannot be undone.`)) {
			await bulkDeleteCredentialsMutation.mutateAsync(ids);
		}
	}

	// Define field configuration for the DataTableControls
	const credentialFields = defineFields<SnmpCredential, SnmpCredentialOrderField>(
		{
			name: { label: common_name(), type: 'string', searchable: true },
			version: { label: common_version(), type: 'string', filterable: true },
			created_at: { label: common_created(), type: 'date' },
			updated_at: { label: common_updated(), type: 'date' }
		},
		[]
	);
</script>

<div class="space-y-6">
	<TabHeader
		title="SNMP Credentials"
		subtitle="Manage SNMP credentials for network device discovery"
	>
		<svelte:fragment slot="actions">
			{#if canManage}
				<button class="btn-primary flex items-center" onclick={handleCreateCredential}>
					<Plus class="h-5 w-5" />{common_create()}
				</button>
			{/if}
		</svelte:fragment>
	</TabHeader>

	{#if isLoading}
		<Loading />
	{:else if credentials.length === 0}
		<EmptyState
			title="No SNMP credentials yet"
			subtitle="Create credentials to enable SNMP discovery on your networks"
			onClick={handleCreateCredential}
			cta={common_create()}
		/>
	{:else}
		<DataControls
			items={credentials}
			fields={credentialFields}
			{allowBulkDelete}
			storageKey="scanopy-snmp-credentials-table-state"
			onBulkDelete={handleBulkDelete}
			getItemId={(item) => item.id}
		>
			{#snippet children(
				item: SnmpCredential,
				viewMode: 'card' | 'list',
				isSelected: boolean,
				onSelectionChange: (selected: boolean) => void
			)}
				<SnmpCredentialCard
					credential={item}
					selected={isSelected}
					{onSelectionChange}
					{viewMode}
					onEdit={handleEditCredential}
					onDelete={handleDeleteCredential}
				/>
			{/snippet}
		</DataControls>
	{/if}
</div>

<SnmpCredentialEditModal
	isOpen={showCredentialEditor}
	credential={editingCredential}
	onCreate={handleCredentialCreate}
	onUpdate={handleCredentialUpdate}
	onClose={handleCloseCredentialEditor}
	onDelete={editingCredential ? () => handleDeleteCredential(editingCredential!) : null}
/>
