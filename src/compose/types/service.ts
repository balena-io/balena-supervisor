import * as Dockerode from 'dockerode';

import { PortMap } from '../ports';

export interface ComposeHealthcheck {
	test: string | string[];
	interval?: string;
	timeout?: string;
	startPeriod?: string;
	retries?: number;
	disable?: boolean;
}

export interface ServiceHealthcheck {
	test: string[];
	interval?: number;
	timeout?: number;
	startPeriod?: number;
	retries?: number;
}

export interface ServiceNetworkDictionary {
	[networkName: string]: {
		aliases?: string[];
		ipv4Address?: string;
		ipv6Address?: string;
		linkLocalIps?: string[];
	};
}

// This is the config directly from the compose file (after running it
// through _.camelCase)
export interface ServiceComposeConfig {
	// Used for converting these fields in a programmatic fashion
	// Unfortunately even keys known at compiler time don't work
	// with the type system, as least at the moment
	[key: string]: any;

	capAdd?: string[];
	capDrop?: string[];
	command?: string[] | string;
	cgroupParent?: string;
	devices?: string[];
	dns?: string | string[];
	dnsOpt?: string[];
	dnsSearch?: string | string[];
	tmpfs?: string | string[];
	entrypoint?: string | string[];
	environment?: { [envVarName: string]: string };
	expose?: string[];
	extraHosts?: string[];
	groupAdd?: string[];
	healthcheck?: ComposeHealthcheck;
	image: string;
	init?: string | boolean;
	labels?: { [labelName: string]: string };
	running?: boolean;
	networkMode?: string;
	networks?: string[] | ServiceNetworkDictionary;
	pid?: string;
	pidsLimit?: number;
	ports?: string[];
	securityOpt?: string[];
	stopGracePeriod?: string;
	stopSignal?: string;
	sysctls?: { [name: string]: string };
	ulimits?: {
		[ulimitName: string]: number | { soft: number; hard: number };
	};
	usernsMode?: string;
	volumes?: string[];
	restart?: string;
	cpuShares?: number;
	cpuQuota?: number;
	cpus?: number;
	cpuset?: string;
	domainname?: string;
	hostname?: string;
	ipc?: string;
	macAddress?: string;
	memLimit?: string;
	memReservation?: string;
	oomKillDisable?: boolean;
	oomScoreAdj?: number;
	privileged?: boolean;
	readOnly?: boolean;
	shmSize?: string;
	user?: string;
	workingDir?: string;
	tty?: boolean;
}

// This is identical to ServiceComposeConfig, except for the
// cases where these values are represented by higher level types.
export interface ServiceConfig {
	portMaps: PortMap[];

	capAdd: string[];
	capDrop: string[];
	command: string[];
	cgroupParent: string;
	devices: DockerDevice[];
	deviceRequests: Dockerode.DeviceRequest[];
	dns: string | string[];
	dnsOpt: string[];
	dnsSearch: string | string[];
	tmpfs: string[];
	entrypoint: string | string[];
	environment: { [envVarName: string]: string };
	expose: string[];
	extraHosts: string[];
	groupAdd: string[];
	healthcheck: ServiceHealthcheck;
	image: string;
	labels: { [labelName: string]: string };
	running: boolean;
	networkMode: string;
	networks: {
		[networkName: string]: {
			aliases?: string[];
			ipv4Address?: string;
			ipv6Address?: string;
			linkLocalIps?: string[];
		};
	};
	pid: string;
	pidsLimit: number;
	securityOpt: string[];
	stopGracePeriod: number;
	stopSignal: string;
	sysctls: { [name: string]: string };
	ulimits: {
		[ulimitName: string]: { soft: number; hard: number };
	};
	usernsMode: string;
	volumes: string[];
	restart: string;
	cpuShares: number;
	cpuQuota: number;
	cpus: number;
	cpuset: string;
	domainname: string;
	hostname: string;
	ipc: string;
	macAddress: string;
	memLimit: number;
	memReservation: number;
	oomKillDisable: boolean;
	oomScoreAdj: number;
	privileged: boolean;
	readOnly: boolean;
	shmSize: number;
	user: string;
	workingDir: string;
	tty: boolean;
}

export type ServiceConfigArrayField =
	| 'volumes'
	| 'devices'
	| 'capAdd'
	| 'capDrop'
	| 'dns'
	| 'dnsSearch'
	| 'dnsOpt'
	| 'expose'
	| 'tmpfs'
	| 'extraHosts'
	| 'ulimitsArray'
	| 'groupAdd'
	| 'securityOpt';

// The config directly from the application manager, which contains
// application information, plus the compose data
export interface ConfigMap {
	[name: string]: any;
}

// When creating a service from the compose data, we need to extend the labels
// and environment variables which more information, defined below. Note
// that these do not need to be provided when create the service object from
// the docker inspect call, because they would have already been set by then.
// TODO: Move these to a more appropriate location once more of the supervisor
// is typescript
export interface DeviceMetadata {
	imageInfo?: Dockerode.ImageInspectInfo;
	uuid: string | null;
	appName: string;
	version: string; // TODO: this is not used anywhere
	deviceType: string;
	deviceArch: string;
	deviceApiKey: string;
	apiEndpoint: string;
	listenPort: number;
	apiSecret: string;
	supervisorApiHost: string;
	osVersion: string;
	hostnameOnHost: string;
	hostPathExists: {
		modules: boolean;
		firmware: boolean;
	};
}

export interface DockerDevice {
	PathOnHost: string;
	PathInContainer: string;
	CgroupPermissions: string;
}
