import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as networkCheck from 'network-checker';
import * as os from 'os';
import * as url from 'url';

import * as constants from './lib/constants';
import { EEXIST } from './lib/errors';
import { checkFalsey } from './lib/validation';

import blink from './lib/blink';

import log from './lib/supervisor-console';

const networkPattern = {
	blinks: 4,
	pause: 1000,
};

let isConnectivityCheckPaused = false;
let isConnectivityCheckEnabled = true;

function checkHost(
	opts: networkCheck.ConnectOptions,
): boolean | PromiseLike<boolean> {
	return (
		!isConnectivityCheckEnabled ||
		isConnectivityCheckPaused ||
		networkCheck.checkHost(opts)
	);
}

function customMonitor(
	options: networkCheck.ConnectOptions,
	fn: networkCheck.MonitorChangeFunction,
) {
	return networkCheck.monitor(checkHost, options, fn);
}

export function enableCheck(enable: boolean) {
	isConnectivityCheckEnabled = enable;
}

export async function isVPNActive(): Promise<boolean> {
	let active: boolean = true;
	try {
		await fs.lstat(`${constants.vpnStatusPath}/active`);
	} catch (e) {
		active = false;
	}
	log.info(`VPN connection is ${active ? 'active' : 'not active'}.`);
	return active;
}

async function vpnStatusInotifyCallback(): Promise<void> {
	isConnectivityCheckPaused = await isVPNActive();
}

export const startConnectivityCheck = _.once(
	async (
		apiEndpoint: string,
		enable: boolean,
		onChangeCallback?: networkCheck.MonitorChangeFunction,
	) => {
		enableConnectivityCheck(enable);
		if (!apiEndpoint) {
			log.debug('No API endpoint specified, skipping connectivity check');
			return;
		}

		await Bluebird.resolve(fs.mkdir(constants.vpnStatusPath))
			.catch(EEXIST, () => {
				log.debug('VPN status path exists.');
			})
			.then(() => {
				fs.watch(constants.vpnStatusPath, vpnStatusInotifyCallback);
			});

		if (enable) {
			vpnStatusInotifyCallback();
		}

		const parsedUrl = url.parse(apiEndpoint);
		const port = parseInt(parsedUrl.port!, 10);

		customMonitor(
			{
				host: parsedUrl.hostname ?? undefined,
				port: port || (parsedUrl.protocol === 'https' ? 443 : 80),
				path: parsedUrl.path || '/',
				interval: 10 * 1000,
			},
			(connected) => {
				onChangeCallback?.(connected);
				if (connected) {
					log.info('Internet Connectivity: OK');
					blink.pattern.stop();
				} else {
					log.info('Waiting for connectivity...');
					blink.pattern.start(networkPattern);
				}
			},
		);
	},
);

export function enableConnectivityCheck(enable: boolean) {
	// Only disable if value explicitly matches falsey
	enable = !checkFalsey(enable);
	enableCheck(enable);
	log.debug(`Connectivity check enabled: ${enable}`);
}

export const connectivityCheckEnabled = Bluebird.method(
	() => isConnectivityCheckEnabled,
);

const IP_REGEX = /^(?:balena|docker|rce|tun)[0-9]+|tun[0-9]+|resin-vpn|lo|resin-dns|supervisor0|balena-redsocks|resin-redsocks|br-[0-9a-f]{12}$/;

export const shouldReportInterface = (intf: string) => !IP_REGEX.test(intf);

export function getIPAddresses(): string[] {
	// We get IP addresses but ignore:
	// - docker and balena bridges (docker0, docker1, balena0, etc)
	// - legacy rce bridges (rce0, etc)
	// - tun interfaces like the legacy vpn
	// - the resin VPN interface (resin-vpn)
	// - loopback interface (lo)
	// - the bridge for dnsmasq (resin-dns)
	// - the docker network for the supervisor API (supervisor0)
	// - custom docker network bridges (br- + 12 hex characters)
	return _(os.networkInterfaces())
		.filter((_interfaceFields, interfaceName) =>
			shouldReportInterface(interfaceName),
		)
		.flatMap((validInterfaces) => {
			return _(validInterfaces)
				.pickBy({ family: 'IPv4', internal: false })
				.map('address')
				.value();
		})
		.value();
}

export function startIPAddressUpdate(): (
	callback: (ips: string[]) => void,
	interval: number,
) => void {
	let lastIPValues: string[] | null = null;
	return (cb, interval) => {
		const getAndReportIP = () => {
			const ips = getIPAddresses();
			if (!_(ips).xor(lastIPValues).isEmpty()) {
				lastIPValues = ips;
				cb(ips);
			}
		};

		setInterval(getAndReportIP, interval);
		getAndReportIP();
	};
}
