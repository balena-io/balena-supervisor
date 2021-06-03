import { ComposeNetworkConfig } from '../compose/types/network';
import { ServiceComposeConfig } from '../compose/types/service';
import { ComposeVolumeConfig } from '../compose/volume';
import { EnvVarObject, LabelObject } from '../lib/types';

import App from '../compose/app';

export type DeviceReportFields = Partial<{
	api_port: number;
	api_secret: string | null;
	ip_address: string;
	os_version: string | null;
	os_variant: string | null;
	supervisor_version: string;
	provisioning_progress: null | number;
	provisioning_state: string;
	status: string;
	update_failed: boolean;
	update_pending: boolean;
	update_downloaded: boolean;
	is_on__commit: string;
	logs_channel: null;
	mac_address: string | null;
}>;

// This is the state that is sent to the cloud
export interface DeviceStatus {
	local?: {
		config?: Dictionary<string>;
		apps?: {
			[appId: string]: {
				services: {
					[serviceId: string]: {
						status: string;
						releaseId: number;
						download_progress: number | null;
					};
				};
			};
		};
	} & DeviceReportFields;
	// TODO: Type the dependent entry correctly
	dependent?: {
		[key: string]: any;
	};
	commit?: string;
}

// TODO: Define this with io-ts so we can perform validation
// on the target state from the api, local mode, and preload
export interface TargetState {
	local: {
		name: string;
		config: EnvVarObject;
		apps: {
			[uuid: string]: {
				appId: number;
				name: string;
				commit: string;
				releaseId: number;
				releaseVersion: string;
				isHost?: boolean;
				services: {
					[serviceId: string]: {
						labels: LabelObject;
						imageId: number;
						serviceName: string;
						image: string;
						running?: boolean;
						environment: Dictionary<string>;
					} & ServiceComposeConfig;
				};
				volumes: Dictionary<Partial<ComposeVolumeConfig>>;
				networks: Dictionary<Partial<ComposeNetworkConfig>>;
			};
		};
	};
	// TODO: Correctly type this once dependent devices are
	// actually properly supported
	dependent: {
		apps: Array<{
			name?: string;
			image?: string;
			commit?: string;
			config?: EnvVarObject;
			environment?: EnvVarObject;
		}>;
		devices: Array<{
			name?: string;
			apps?: Dictionary<{
				config?: EnvVarObject;
				environment?: EnvVarObject;
			}>;
		}>;
	};
}

export type LocalTargetState = TargetState['local'];
export type TargetApplications = LocalTargetState['apps'];
export type TargetApplication = LocalTargetState['apps'][0];
export type TargetApplicationService = TargetApplication['services'][0];
export type AppsJsonFormat = Omit<TargetState['local'], 'name'> & {
	pinDevice?: boolean;
};

export type InstancedAppState = { [appId: number]: App };

export interface InstancedDeviceState {
	local: {
		name: string;
		config: Dictionary<string>;
		apps: InstancedAppState;
	};
	dependent: any;
}
