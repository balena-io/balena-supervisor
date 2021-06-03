import { checkString } from './validation';

const bootMountPointFromEnv = checkString(process.env.BOOT_MOUNTPOINT);
const rootMountPoint = checkString(process.env.ROOT_MOUNTPOINT) || '/mnt/root';

const supervisorNetworkInterface = 'supervisor0';

const constants = {
	rootMountPoint,
	databasePath:
		checkString(process.env.DATABASE_PATH) || '/data/database.sqlite',
	containerId:
		checkString(process.env.SUPERVISOR_CONTAINER_ID) || 'balena_supervisor',
	dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',

	// In-container location for docker socket
	// Mount in /host/run to avoid clashing with systemd
	containerDockerSocket: '/host/run/balena-engine.sock',
	supervisorImage:
		checkString(process.env.SUPERVISOR_IMAGE) || 'resin/rpi-supervisor',
	ledFile:
		checkString(process.env.LED_FILE) || '/sys/class/leds/led0/brightness',
	vpnStatusPath:
		checkString(process.env.VPN_STATUS_PATH) ||
		`${rootMountPoint}/run/openvpn/vpn_status`,
	hostOSVersionPath:
		checkString(process.env.HOST_OS_VERSION_PATH) ||
		`${rootMountPoint}/etc/os-release`,
	macAddressPath:
		checkString(process.env.MAC_ADDRESS_PATH) ||
		`${rootMountPoint}/sys/class/net`,
	privateAppEnvVars: [
		'RESIN_SUPERVISOR_API_KEY',
		'RESIN_API_KEY',
		'BALENA_SUPERVISOR_API_KEY',
		'BALENA_API_KEY',
	],
	bootMountPointFromEnv,
	bootMountPoint: bootMountPointFromEnv || '/boot',
	configJsonPathOnHost: checkString(process.env.CONFIG_JSON_PATH),
	proxyvisorHookReceiver: 'http://0.0.0.0:1337',
	configJsonNonAtomicPath: '/boot/config.json',
	defaultMixpanelToken: process.env.DEFAULT_MIXPANEL_TOKEN,
	supervisorNetworkInterface,
	allowedInterfaces: [
		'resin-vpn',
		'tun0',
		'docker0',
		'lo',
		supervisorNetworkInterface,
	],
	appsJsonPath: process.env.APPS_JSON_PATH || '/boot/apps.json',
	ipAddressUpdateInterval: 30 * 1000,
	imageCleanupErrorIgnoreTimeout: 3600 * 1000,
	maxDeltaDownloads: 3,
	defaultVolumeLabels: {
		'io.balena.supervised': 'true',
	},
	bootBlockDevice: '/dev/mmcblk0p1',
	hostConfigVarPrefix: 'HOST_',
	migrationBackupFile: 'backup.tgz',
	// Use this failure multiplied by 2**Number of failures to increase
	// the backoff on subsequent failures
	backoffIncrement: 500,
	supervisorNetworkSubnet: '10.114.104.0/25',
	supervisorNetworkGateway: '10.114.104.1',
	// How often can we report our state to the server in ms
	maxReportFrequency: 10 * 1000,
	// How much of a jitter we can add to our api polling
	// (this number is used as an upper bound when generating
	// a random jitter)
	maxApiJitterDelay: 60 * 1000,
	validRedsocksProxyTypes: ['socks4', 'socks5', 'http-connect', 'http-relay'],
};

if (process.env.DOCKER_HOST == null) {
	process.env.DOCKER_HOST = `unix://${constants.dockerSocket}`;
}

export = constants;
