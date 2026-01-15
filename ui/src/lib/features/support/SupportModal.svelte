<script lang="ts">
	import { Bug, AlertTriangle, Lightbulb, LifeBuoy, BookOpen, Mail } from 'lucide-svelte';
	import GenericModal from '$lib/shared/components/layout/GenericModal.svelte';
	import ModalHeaderIcon from '$lib/shared/components/layout/ModalHeaderIcon.svelte';
	import { VERSION } from '$lib/version';
	import { createColorHelper, type Color } from '$lib/shared/utils/styling';
	import type { IconComponent } from '$lib/shared/utils/types';
	import { useOrganizationQuery } from '../organizations/queries';
	import { billingPlans } from '$lib/shared/stores/metadata';
	import { useCurrentUserQuery } from '$lib/features/auth/queries';
	import InfoCard from '$lib/shared/components/data/InfoCard.svelte';
	import InfoRow from '$lib/shared/components/data/InfoRow.svelte';
	import * as m from '$lib/paraglide/messages';

	type SupportOption = {
		title: string;
		description: string;
		url: string;
		color: Color;
		icon: IconComponent | string;
	};

	let {
		isOpen = false,
		onClose
	}: {
		isOpen: boolean;
		onClose: () => void;
	} = $props();

	// TanStack Query for current user and organization
	const currentUserQuery = useCurrentUserQuery();
	let currentUser = $derived(currentUserQuery.data);

	const organizationQuery = useOrganizationQuery();
	let organization = $derived(organizationQuery.data);

	let hasEmailSupport = $derived.by(() => {
		if (!organization || !organization.plan) return false;

		let features = billingPlans.getMetadata(organization.plan.type).features;
		return features.email_support;
	});

	let supportOptions = $derived.by(() => {
		const options: SupportOption[] = [
			{
				title: m.support_userGuide(),
				description: m.support_userGuideDesc(),
				url: 'https://scanopy.net/docs/',
				color: 'Gray',
				icon: BookOpen
			},
			{
				title: m.support_incorrectDetection(),
				description: m.support_incorrectDetectionDesc(),
				url: 'https://github.com/scanopy/scanopy/issues/new?template=service-detection-issue.md',
				color: 'Yellow',
				icon: AlertTriangle
			},
			{
				title: m.support_requestFeature(),
				description: m.support_requestFeatureDesc(),
				url: 'https://github.com/scanopy/scanopy/issues/new?template=feature_request.md',
				color: 'Green',
				icon: Lightbulb
			},
			{
				title: m.support_reportBug(),
				description: m.support_reportBugDesc(),
				url: 'https://github.com/scanopy/scanopy/issues/new?template=bug_report.md',
				color: 'Red',
				icon: Bug
			},
			{
				title: 'Discord',
				description: m.support_discordDesc(),
				url: 'https://discord.gg/b7ffQr8AcZ',
				color: 'Indigo',
				icon: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/discord.svg'
			}
		];

		if (hasEmailSupport) {
			options.push({
				title: m.common_email(),
				description: m.support_emailDesc(),
				url: 'mailto:support@scanopy.net',
				color: 'Blue',
				icon: Mail
			});
		}

		return options;
	});

	function handleCardClick(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

<GenericModal {isOpen} title={m.support_title()} {onClose} size="xl">
	{#snippet headerIcon()}
		<ModalHeaderIcon Icon={LifeBuoy} color="Blue" />
	{/snippet}

	<div class="flex min-h-0 flex-1 flex-col">
		<div class="flex-1 space-y-6 overflow-auto p-6">
			<p class="text-secondary text-sm">
				{m.support_description()}
			</p>

			<div class="grid grid-cols-2 gap-3">
				{#each supportOptions as option (option.description)}
					{@const colors = createColorHelper(option.color)}
					<button onclick={() => handleCardClick(option.url)} class="card w-full text-left">
						<div class="flex items-center gap-3">
							<div
								class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg {colors.bg}"
							>
								{#if typeof option.icon === 'string'}
									<img src={option.icon} alt={option.title} class="h-5 w-5" />
								{:else}
									<option.icon class="h-5 w-5 {colors.icon}" />
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<p class="text-primary text-sm font-medium">{option.title}</p>
								<p class="text-secondary truncate text-xs">{option.description}</p>
							</div>
						</div>
					</button>
				{/each}
			</div>
			<InfoCard title={m.support_info()}>
				<InfoRow label={m.common_version()}>{VERSION}</InfoRow>
				<InfoRow label={m.support_orgId()} mono={true}>
					{organization?.id ?? '—'}
				</InfoRow>
				<InfoRow label={m.common_userId()} mono={true}>{currentUser?.id ?? '—'}</InfoRow>
			</InfoCard>
		</div>

		<div class="modal-footer">
			<div class="flex justify-end">
				<button type="button" onclick={onClose} class="btn-secondary">{m.common_close()}</button>
			</div>
		</div>
	</div>
</GenericModal>
