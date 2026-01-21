<script lang="ts">
	import type { IfEntry } from '$lib/features/hosts/types/base';
	import { ADMIN_STATUS_LABELS, OPER_STATUS_LABELS } from '$lib/features/snmp/types/base';

	interface Props {
		ifEntry: IfEntry;
	}

	let { ifEntry }: Props = $props();

	function formatSpeed(speed: number | null | undefined): string {
		if (!speed) return 'Unknown';
		if (speed >= 1_000_000_000) return `${(speed / 1_000_000_000).toFixed(1)} Gbps`;
		if (speed >= 1_000_000) return `${(speed / 1_000_000).toFixed(1)} Mbps`;
		if (speed >= 1_000) return `${(speed / 1_000).toFixed(1)} Kbps`;
		return `${speed} bps`;
	}

	let adminStatusLabel = $derived(ADMIN_STATUS_LABELS[ifEntry.admin_status] ?? 'Unknown');

	let operStatusLabel = $derived(OPER_STATUS_LABELS[ifEntry.oper_status] ?? 'Unknown');

	let operStatusColor = $derived(() => {
		switch (ifEntry.oper_status) {
			case 'Up':
				return 'text-green-400 bg-green-400/10';
			case 'Down':
				return 'text-red-400 bg-red-400/10';
			case 'Dormant':
				return 'text-yellow-400 bg-yellow-400/10';
			default:
				return 'text-gray-400 bg-gray-400/10';
		}
	});
</script>

<div class="space-y-6 p-6">
	<!-- Header -->
	<div class="border-b border-gray-700 pb-4">
		<h3 class="text-primary text-lg font-medium">
			{ifEntry.if_descr || `Interface ${ifEntry.if_index}`}
		</h3>
		<p class="text-muted mt-1 text-sm">SNMP Interface Index: {ifEntry.if_index}</p>
	</div>

	<!-- Status Section -->
	<div class="space-y-4">
		<h4 class="text-secondary text-sm font-medium uppercase tracking-wide">Status</h4>
		<div class="grid grid-cols-2 gap-4">
			<div class="bg-tertiary/30 rounded-lg p-4">
				<span class="text-secondary block text-xs font-medium">Administrative Status</span>
				<p class="text-primary mt-1 text-sm font-medium">{adminStatusLabel}</p>
			</div>
			<div class="bg-tertiary/30 rounded-lg p-4">
				<span class="text-secondary block text-xs font-medium">Operational Status</span>
				<span
					class="mt-1 inline-flex items-center rounded px-2 py-0.5 text-sm font-medium {operStatusColor()}"
				>
					{operStatusLabel}
				</span>
			</div>
		</div>
	</div>

	<!-- Interface Details Section -->
	<div class="space-y-4">
		<h4 class="text-secondary text-sm font-medium uppercase tracking-wide">Interface Details</h4>
		<div class="grid grid-cols-2 gap-4">
			<div class="bg-tertiary/30 rounded-lg p-4">
				<span class="text-secondary block text-xs font-medium">Interface Type</span>
				<p class="text-primary mt-1 text-sm">{ifEntry.if_type}</p>
			</div>

			{#if ifEntry.mac_address}
				<div class="bg-tertiary/30 rounded-lg p-4">
					<span class="text-secondary block text-xs font-medium">Physical Address (MAC)</span>
					<p class="text-primary mt-1 font-mono text-sm">{ifEntry.mac_address}</p>
				</div>
			{/if}

			<div class="bg-tertiary/30 rounded-lg p-4">
				<span class="text-secondary block text-xs font-medium">Speed</span>
				<p class="text-primary mt-1 text-sm">{formatSpeed(ifEntry.speed_bps)}</p>
			</div>
		</div>
	</div>

	<!-- Alias Section -->
	{#if ifEntry.if_alias}
		<div class="space-y-4">
			<h4 class="text-secondary text-sm font-medium uppercase tracking-wide">
				Alias / Description
			</h4>
			<div class="bg-tertiary/30 rounded-lg p-4">
				<p class="text-primary text-sm">{ifEntry.if_alias}</p>
			</div>
		</div>
	{/if}

	<!-- CDP Neighbor Info Section -->
	{#if ifEntry.cdp_device_id || ifEntry.cdp_port_id || ifEntry.cdp_address}
		<div class="space-y-4">
			<h4 class="text-secondary text-sm font-medium uppercase tracking-wide">
				CDP Neighbor Information
			</h4>
			<div class="grid grid-cols-2 gap-4">
				{#if ifEntry.cdp_device_id}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote Device</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.cdp_device_id}</p>
					</div>
				{/if}
				{#if ifEntry.cdp_port_id}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote Port</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.cdp_port_id}</p>
					</div>
				{/if}
				{#if ifEntry.cdp_address}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote Address</span>
						<p class="text-primary mt-1 font-mono text-sm">{ifEntry.cdp_address}</p>
					</div>
				{/if}
				{#if ifEntry.cdp_platform}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote Platform</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.cdp_platform}</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- LLDP Neighbor Info Section -->
	{#if ifEntry.lldp_sys_name || ifEntry.lldp_port_desc || ifEntry.lldp_mgmt_addr}
		<div class="space-y-4">
			<h4 class="text-secondary text-sm font-medium uppercase tracking-wide">
				LLDP Neighbor Information
			</h4>
			<div class="grid grid-cols-2 gap-4">
				{#if ifEntry.lldp_sys_name}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote System Name</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.lldp_sys_name}</p>
					</div>
				{/if}
				{#if ifEntry.lldp_port_desc}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Remote Port</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.lldp_port_desc}</p>
					</div>
				{/if}
				{#if ifEntry.lldp_mgmt_addr}
					<div class="bg-tertiary/30 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">Management Address</span>
						<p class="text-primary mt-1 font-mono text-sm">{ifEntry.lldp_mgmt_addr}</p>
					</div>
				{/if}
				{#if ifEntry.lldp_sys_desc}
					<div class="bg-tertiary/30 col-span-2 rounded-lg p-4">
						<span class="text-secondary block text-xs font-medium">System Description</span>
						<p class="text-primary mt-1 text-sm">{ifEntry.lldp_sys_desc}</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
