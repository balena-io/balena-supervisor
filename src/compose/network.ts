import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as dockerode from 'dockerode';

import { docker } from '../lib/docker-utils';
import logTypes = require('../lib/log-types');
import * as logger from '../logger';
import log from '../lib/supervisor-console';
import * as ComposeUtils from './utils';

import { ComposeNetworkConfig, NetworkConfig } from './types/network';

import { InvalidNetworkNameError } from './errors';

export class Network {
	public appId: number;
	public name: string;
	public config: NetworkConfig;
	public uuid?: string;

	private constructor() {}

	public static fromDockerNetwork(
		network: dockerode.NetworkInspectInfo,
	): Network {
		const ret = new Network();

		const match = network.Name.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			throw new InvalidNetworkNameError(network.Name);
		}

		// If the regex match succeeds `match[1]` should be a number
		const appId = parseInt(match[1], 10);

		ret.appId = appId;
		ret.name = match[2];

		const config = network.IPAM?.Config || [];

		ret.config = {
			driver: network.Driver,
			ipam: {
				driver: network.IPAM?.Driver ?? 'default',
				config: config.map((conf) => ({
					...(conf.Subnet && { subnet: conf.Subnet }),
					...(conf.Gateway && { gateway: conf.Gateway }),
					...(conf.IPRange && { ipRange: conf.IPRange }),
					...(conf.AuxAddress && { auxAddress: conf.AuxAddress }),
				})),
				options: network.IPAM?.Options ?? {},
			},
			enableIPv6: network.EnableIPv6,
			internal: network.Internal,
			labels: _.omit(ComposeUtils.normalizeLabels(network.Labels ?? {}), [
				'io.balena.supervised',
			]),
			options: network.Options ?? {},
		};

		ret.uuid = ret.config.labels['io.balena.app-uuid'];

		return ret;
	}

	public static fromComposeObject(
		name: string,
		appId: number,
		uuid: string,
		network: Partial<Omit<ComposeNetworkConfig, 'ipam'>> & {
			ipam?: Partial<ComposeNetworkConfig['ipam']>;
		},
	): Network {
		const net = new Network();
		net.name = name;
		net.appId = appId;

		Network.validateComposeConfig(network);

		const ipam = network.ipam ?? {};
		const driver = ipam.driver ?? 'default';
		const config = ipam.config ?? [];
		const options = ipam.options ?? {};

		net.config = {
			driver: network.driver || 'bridge',
			ipam: {
				driver,
				config: config.map((conf) => ({
					...(conf.subnet && { subnet: conf.subnet }),
					...(conf.gateway && { gateway: conf.gateway }),
					...(conf.ip_range && { ipRange: conf.ip_range }),
					// TODO: compose defines aux_addresses as a dict but dockerode and the
					// engine accepts a single AuxAddress. What happens when multiple addresses
					// are given?
					...(conf.aux_addresses && { auxAddress: conf.aux_addresses }),
				})) as ComposeNetworkConfig['ipam']['config'],
				options,
			},
			enableIPv6: network.enable_ipv6 || false,
			internal: network.internal || false,
			labels: network.labels || {},
			options: network.driver_opts || {},
		};

		net.config.labels = {
			...ComposeUtils.normalizeLabels(net.config.labels),
			'io.balena.app-uuid': uuid,
		};
		net.uuid = uuid;

		return net;
	}

	public toComposeObject(): ComposeNetworkConfig {
		return {
			driver: this.config.driver,
			driver_opts: this.config.options,
			enable_ipv6: this.config.enableIPv6,
			internal: this.config.internal,
			ipam: this.config.ipam,
			labels: this.config.labels,
		};
	}

	public async create(): Promise<void> {
		logger.logSystemEvent(logTypes.createNetwork, {
			network: { name: this.name },
		});

		await docker.createNetwork(this.toDockerConfig());
	}

	public toDockerConfig(): dockerode.NetworkCreateOptions {
		return {
			Name: Network.generateDockerName(this.appId, this.name),
			Driver: this.config.driver,
			CheckDuplicate: true,
			Options: this.config.options,
			IPAM: {
				Driver: this.config.ipam.driver,
				Config: this.config.ipam.config.map((conf) => {
					return {
						...(conf.subnet && { Subnet: conf.subnet }),
						...(conf.gateway && { Gateway: conf.gateway }),
						...(conf.auxAddress && { AuxAddress: conf.auxAddress }),
						...(conf.ipRange && { IPRange: conf.ipRange }),
					};
				}),
				Options: this.config.ipam.options,
			},
			EnableIPv6: this.config.enableIPv6,
			Internal: this.config.internal,
			Labels: _.merge(
				{},
				{
					'io.balena.supervised': 'true',
				},
				this.config.labels,
			),
		};
	}

	public remove(): Bluebird<void> {
		logger.logSystemEvent(logTypes.removeNetwork, {
			network: { name: this.name, appId: this.appId },
		});

		const networkName = Network.generateDockerName(this.appId, this.name);

		return Bluebird.resolve(docker.listNetworks())
			.then((networks) => networks.filter((n) => n.Name === networkName))
			.then(([network]) => {
				if (!network) {
					return Bluebird.resolve();
				}
				return Bluebird.resolve(
					docker.getNetwork(networkName).remove(),
				).tapCatch((error) => {
					logger.logSystemEvent(logTypes.removeNetworkError, {
						network: { name: this.name, appId: this.appId },
						error,
					});
				});
			});
	}

	public isEqualConfig(network: Network): boolean {
		// don't compare the ipam.config if it's not present
		// in the target state (as it will be present in the
		// current state, due to docker populating it with
		// default or generated values)
		let configToCompare = this.config;
		if (network.config.ipam.config.length === 0) {
			configToCompare = _.cloneDeep(this.config);
			configToCompare.ipam.config = [];
		}

		return _.isEqual(configToCompare, network.config);
	}

	private static validateComposeConfig(
		config: Partial<Omit<ComposeNetworkConfig, 'ipam'>> & {
			ipam?: Partial<ComposeNetworkConfig['ipam']>;
		},
	): void {
		// Check if every ipam config entry has both a subnet and a gateway
		if (
			_.some(
				_.get(config, 'ipam.config', []),
				({ subnet, gateway }) => !subnet || !gateway,
			)
		) {
			log.warn(
				'Network IPAM config entries must have both a subnet and gateway defined.' +
					' Your network might not work properly otherwise.',
			);
		}
	}

	public static generateDockerName(appId: number, name: string) {
		return `${appId}_${name}`;
	}
}

export default Network;
