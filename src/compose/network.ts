import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { docker } from '../lib/docker-utils';
import { InvalidAppIdError } from '../lib/errors';
import * as logTypes from '../lib/log-types';
import { checkInt } from '../lib/validation';
import * as logger from '../logger';
import * as ComposeUtils from './utils';

import {
	ComposeNetworkConfig,
	DockerIPAMConfig,
	DockerNetworkConfig,
	NetworkConfig,
	NetworkInspect,
} from './types/network';

import {
	InvalidNetworkConfigurationError,
	InvalidNetworkNameError,
} from './errors';

export class Network {
	public appId: number;
	public name: string;
	public config: NetworkConfig;

	private constructor() {}

	public static fromDockerNetwork(network: NetworkInspect): Network {
		const ret = new Network();

		const match = network.Name.match(/^([0-9]+)_(.+)$/);
		if (match == null) {
			throw new InvalidNetworkNameError(network.Name);
		}
		const appId = checkInt(match[1]) || null;
		if (!appId) {
			throw new InvalidAppIdError(match[1]);
		}

		ret.appId = appId;
		ret.name = match[2];
		ret.config = {
			driver: network.Driver,
			ipam: {
				driver: network.IPAM.Driver,
				config: _.map(network.IPAM.Config, (conf) => {
					const newConf: NetworkConfig['ipam']['config'][0] = {};

					if (conf.Subnet != null) {
						newConf.subnet = conf.Subnet;
					}
					if (conf.Gateway != null) {
						newConf.gateway = conf.Gateway;
					}
					if (conf.IPRange != null) {
						newConf.ipRange = conf.IPRange;
					}
					if (conf.AuxAddress != null) {
						newConf.auxAddress = conf.AuxAddress;
					}

					return newConf;
				}),
				options: network.IPAM.Options == null ? {} : network.IPAM.Options,
			},
			enableIPv6: network.EnableIPv6,
			internal: network.Internal,
			labels: _.omit(ComposeUtils.normalizeLabels(network.Labels), [
				'io.balena.supervised',
			]),
			options: network.Options,
		};

		return ret;
	}

	public static fromComposeObject(
		name: string,
		appId: number,
		network: Partial<Omit<ComposeNetworkConfig, 'ipam'>> & {
			ipam?: Partial<ComposeNetworkConfig['ipam']>;
		},
	): Network {
		const net = new Network();
		net.name = name;
		net.appId = appId;

		Network.validateComposeConfig(network);

		const ipam: Partial<ComposeNetworkConfig['ipam']> = network.ipam || {};
		if (ipam.driver == null) {
			ipam.driver = 'default';
		}
		if (ipam.config == null) {
			ipam.config = [];
		}
		if (ipam.options == null) {
			ipam.options = {};
		}
		net.config = {
			driver: network.driver || 'bridge',
			ipam: ipam as ComposeNetworkConfig['ipam'],
			enableIPv6: network.enable_ipv6 || false,
			internal: network.internal || false,
			labels: network.labels || {},
			options: network.driver_opts || {},
		};

		net.config.labels = ComposeUtils.normalizeLabels(net.config.labels);

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

		return await docker.createNetwork(this.toDockerConfig());
	}

	public toDockerConfig(): DockerNetworkConfig {
		return {
			Name: Network.generateDockerName(this.appId, this.name),
			Driver: this.config.driver,
			CheckDuplicate: true,
			IPAM: {
				Driver: this.config.ipam.driver,
				Config: _.map(this.config.ipam.config, (conf) => {
					const ipamConf: DockerIPAMConfig = {};
					if (conf.subnet != null) {
						ipamConf.Subnet = conf.subnet;
					}
					if (conf.gateway != null) {
						ipamConf.Gateway = conf.gateway;
					}
					if (conf.auxAddress != null) {
						ipamConf.AuxAddress = conf.auxAddress;
					}
					if (conf.ipRange != null) {
						ipamConf.IPRange = conf.ipRange;
					}
					return ipamConf;
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
		_.each(_.get(config, 'ipam.config', []), ({ subnet, gateway }) => {
			if (!subnet || !gateway) {
				throw new InvalidNetworkConfigurationError(
					'Network IPAM config entries must have both a subnet and gateway',
				);
			}
		});
	}

	public static generateDockerName(appId: number, name: string) {
		return `${appId}_${name}`;
	}
}

export default Network;
