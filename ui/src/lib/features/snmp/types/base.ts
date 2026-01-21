import type { components } from '$lib/api/schema';
import { utcTimeZoneSentinel, uuidv4Sentinel } from '$lib/shared/utils/formatting';

export type SnmpCredential = components['schemas']['SnmpCredential'];
export type SnmpCredentialBase = components['schemas']['SnmpCredentialBase'];
export type SnmpVersion = components['schemas']['SnmpVersion'];
export type IfEntry = components['schemas']['IfEntry'];
export type IfAdminStatus = components['schemas']['IfAdminStatus'];
export type IfOperStatus = components['schemas']['IfOperStatus'];

export function createDefaultSnmpCredential(organization_id: string): SnmpCredential {
	return {
		name: '',
		version: 'V2c',
		community: '',
		organization_id,
		id: uuidv4Sentinel,
		created_at: utcTimeZoneSentinel,
		updated_at: utcTimeZoneSentinel
	};
}

/**
 * Human-readable labels for SNMP admin status
 */
export const ADMIN_STATUS_LABELS: Record<IfAdminStatus, string> = {
	Up: 'Admin Up',
	Down: 'Admin Down',
	Testing: 'Testing'
};

/**
 * Human-readable labels for SNMP operational status
 */
export const OPER_STATUS_LABELS: Record<IfOperStatus, string> = {
	Up: 'Up',
	Down: 'Down',
	Testing: 'Testing',
	Unknown: 'Unknown',
	Dormant: 'Dormant',
	NotPresent: 'Not Present',
	LowerLayerDown: 'Lower Layer Down'
};
