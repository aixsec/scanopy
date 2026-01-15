<script lang="ts">
	import { useNetworksQuery } from '$lib/features/networks/queries';
	import CodeContainer from '$lib/shared/components/data/CodeContainer.svelte';
	import InlineWarning from '$lib/shared/components/feedback/InlineWarning.svelte';
	import GenericModal from '$lib/shared/components/layout/GenericModal.svelte';
	import ModalHeaderIcon from '$lib/shared/components/layout/ModalHeaderIcon.svelte';
	import { pushError } from '$lib/shared/stores/feedback';
	import { entities } from '$lib/shared/stores/metadata';
	import type { Daemon } from '../types/base';
	import SelectNetwork from '$lib/features/networks/components/SelectNetwork.svelte';
	import { SatelliteDish } from 'lucide-svelte';
	import {
		createEmptyApiKeyFormData,
		useCreateApiKeyMutation
	} from '$lib/features/daemon_api_keys/queries';
	import { useConfigQuery } from '$lib/shared/stores/config-query';
	import InlineInfo from '$lib/shared/components/feedback/InlineInfo.svelte';
	import CreateDaemonForm from './CreateDaemonForm.svelte';
	import * as m from '$lib/paraglide/messages';

	interface Props {
		isOpen?: boolean;
		onClose: () => void;
		daemon?: Daemon | null;
		onboardingMode?: boolean;
		onSkip?: (() => void) | null;
		onContinue?: (() => void) | null;
		provisionalApiKey?: string | null;
		provisionalNetworkId?: string | null;
	}

	let {
		isOpen = false,
		onClose,
		daemon = null,
		onboardingMode = false,
		onSkip = null,
		onContinue = null,
		provisionalApiKey = null,
		provisionalNetworkId = null
	}: Props = $props();

	const networksQuery = useNetworksQuery();
	const configQuery = useConfigQuery();
	const createApiKeyMutation = useCreateApiKeyMutation();

	let networksData = $derived(networksQuery.data ?? []);
	let configData = $derived(configQuery.data);

	let keyState = $state<string | null>(null);
	// In onboarding mode, use the provisionalApiKey; otherwise use keyState
	let key = $derived(onboardingMode ? provisionalApiKey : keyState);
	// In onboarding mode, use the provisionalNetworkId; otherwise use first network or daemon's network
	let selectedNetworkId = $state('');

	$effect(() => {
		if (daemon) {
			selectedNetworkId = daemon.network_id;
		} else if (onboardingMode && provisionalNetworkId) {
			selectedNetworkId = provisionalNetworkId;
		} else if (!selectedNetworkId && networksData[0]?.id) {
			selectedNetworkId = networksData[0].id;
		}
	});

	let serverUrl = $derived(configData?.public_url ?? '');

	// Reference to CreateDaemonForm for getting daemon name
	let daemonFormRef: CreateDaemonForm;

	function handleOnClose() {
		keyState = null;
		onClose();
	}

	async function handleUseExistingKey() {
		// Validate form first (same pattern as handleCreateNewApiKey)
		const isValid = await daemonFormRef?.validate();
		if (!isValid) {
			return;
		}

		const trimmedKey = daemonFormRef?.getExistingKeyInput()?.trim() ?? '';
		if (!trimmedKey) {
			pushError(m.daemons_enterApiKey());
			return;
		}

		keyState = trimmedKey;
	}

	async function handleCreateNewApiKey() {
		// Validate form first
		const isValid = await daemonFormRef?.validate();
		if (!isValid) {
			return;
		}

		const daemonName = daemonFormRef?.getDaemonName() ?? 'daemon';
		let newApiKey = createEmptyApiKeyFormData(selectedNetworkId);
		newApiKey.name = `${daemonName} Api Key`;

		try {
			const result = await createApiKeyMutation.mutateAsync(newApiKey);
			keyState = result.keyString;
		} catch {
			pushError(m.common_failedGenerateApiKey());
		}
	}

	// For existing daemon with new key - simple run command
	let existingDaemonRunCommand = $derived(
		daemon && key ? `sudo scanopy-daemon --server-url ${serverUrl} --daemon-api-key ${key}` : ''
	);

	let colorHelper = entities.getColorHelper('Daemon');
	let title = $derived(onboardingMode ? m.daemons_setupScanning() : m.daemons_createDaemon());
</script>

<GenericModal
	{isOpen}
	{title}
	size="xl"
	onClose={handleOnClose}
	showCloseButton={!onboardingMode}
	showBackdrop={!onboardingMode}
>
	{#snippet headerIcon()}
		{#if onboardingMode}
			<ModalHeaderIcon Icon={SatelliteDish} color="Green" />
		{:else}
			<ModalHeaderIcon Icon={entities.getIconComponent('Daemon')} color={colorHelper.color} />
		{/if}
	{/snippet}

	<div class="flex min-h-0 flex-1 flex-col">
		<div class="flex-1 overflow-auto p-6">
			<div class="space-y-4">
				{#if onboardingMode}
					<!-- Onboarding mode: show info banner -->
					<InlineInfo
						title={m.daemons_activateAfterCreation()}
						body={m.daemons_activateAfterCreationBody()}
					/>
				{:else if !daemon}
					<SelectNetwork
						bind:selectedNetworkId
						disabled={!!key}
						disabledReason={m.daemons_networkCannotChange()}
					/>
				{/if}

				<!-- Use the extracted CreateDaemonForm component -->
				<CreateDaemonForm
					bind:this={daemonFormRef}
					{daemon}
					networkId={selectedNetworkId}
					apiKey={key}
					showAdvanced={!onboardingMode || !!key}
					allowExistingKey={!onboardingMode && !daemon}
					keySet={!!key}
					onGenerateKey={handleCreateNewApiKey}
					onUseExistingKey={handleUseExistingKey}
				/>

				<!-- Existing daemon with new key warning -->
				{#if daemon && key && selectedNetworkId}
					<InlineWarning title={m.daemons_keyNotAvailableWarning()} />

					<div class="text-secondary mt-3">
						<b>{m.daemons_option1()}</b>
						{m.daemons_stopDaemonProcess()}
					</div>
					<CodeContainer language="bash" expandable={false} code={existingDaemonRunCommand} />
					<div class="text-secondary mt-3">
						<b>{m.daemons_option2()}</b>
						{m.daemons_stopDaemonContainer()}
					</div>
					<CodeContainer
						language="bash"
						expandable={false}
						code={`- SCANOPY_DAEMON_API_KEY=${key}\n`}
					/>
				{/if}
			</div>
		</div>

		<!-- Footer -->
		<div class="modal-footer">
			{#if onboardingMode}
				<div class="flex w-full items-center justify-between gap-4">
					{#if onSkip}
						<button type="button" class="btn-secondary" onclick={onSkip}>
							{m.daemons_doThisLater()}
						</button>
					{/if}
					<button type="button" class="btn-primary ml-auto" onclick={onContinue ?? handleOnClose}>
						{m.common_continue()}
					</button>
				</div>
			{:else}
				<div class="flex items-center justify-end">
					<button type="button" class="btn-secondary" onclick={handleOnClose}>
						{m.common_close()}
					</button>
				</div>
			{/if}
		</div>
	</div>
</GenericModal>
