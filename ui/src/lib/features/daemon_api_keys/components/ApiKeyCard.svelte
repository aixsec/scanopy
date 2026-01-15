<script lang="ts">
	import GenericCard from '$lib/shared/components/data/GenericCard.svelte';
	import { entities } from '$lib/shared/stores/metadata';
	import { formatTimestamp } from '$lib/shared/utils/formatting';
	import { Edit, Trash2 } from 'lucide-svelte';
	import type { ApiKey } from '../types/base';
	import TagPickerInline from '$lib/features/tags/components/TagPickerInline.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		apiKey,
		onDelete = () => {},
		onEdit = () => {},
		viewMode,
		selected,
		onSelectionChange = () => {}
	}: {
		apiKey: ApiKey;
		onDelete?: (apiKey: ApiKey) => void;
		onEdit?: (apiKey: ApiKey) => void;
		viewMode: 'card' | 'list';
		selected: boolean;
		onSelectionChange?: (selected: boolean) => void;
	} = $props();

	// Build card data
	let cardData = $derived({
		title: apiKey.name,
		iconColor: entities.getColorHelper('DaemonApiKey').icon,
		Icon: entities.getIconComponent('DaemonApiKey'),
		fields: [
			{
				label: m.common_created(),
				value: formatTimestamp(apiKey.created_at)
			},
			{
				label: m.daemonApiKeys_lastUsed(),
				value: apiKey.last_used ? formatTimestamp(apiKey.last_used) : m.common_never()
			},
			{
				label: m.common_expires(),
				value: apiKey.expires_at
					? new Date(apiKey.expires_at) < new Date()
						? m.common_expired()
						: formatTimestamp(apiKey.expires_at)
					: m.common_never()
			},
			{
				label: m.common_enabled(),
				value: apiKey.is_enabled ? m.common_yes() : m.common_no()
			},
			{ label: m.common_tags(), snippet: tagsSnippet }
		],
		actions: [
			{
				label: m.common_delete(),
				icon: Trash2,
				class: 'btn-icon-danger',
				onClick: () => onDelete(apiKey)
			},
			{
				label: m.common_edit(),
				icon: Edit,
				class: 'btn-icon',
				onClick: () => onEdit(apiKey)
			}
		]
	});
</script>

{#snippet tagsSnippet()}
	<div class="flex items-center gap-2">
		<span class="text-secondary text-sm">{m.common_tags()}:</span>
		<TagPickerInline selectedTagIds={apiKey.tags} entityId={apiKey.id} entityType="DaemonApiKey" />
	</div>
{/snippet}

<GenericCard {...cardData} {viewMode} {selected} {onSelectionChange} />
