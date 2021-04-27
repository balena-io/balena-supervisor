import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { fs } from 'mz';

import * as constants from '../lib/constants';
import { docker } from '../lib/docker-utils';
import { ENOENT, NotFoundError } from '../lib/errors';
import * as logTypes from '../lib/log-types';
import * as logger from '../logger';
import { Network } from './network';

import log from '../lib/supervisor-console';
import { ResourceRecreationAttemptError } from './errors';

export function getAll(): Bluebird<Network[]> {
	return getWithBothLabels().map((network: { Name: string }) => {
		return docker
			.getNetwork(network.Name)
			.inspect()
			.then((net) => {
				return Network.fromDockerNetwork(net);
			});
	});
}

export function getAllByAppId(appId: number): Bluebird<Network[]> {
	return getAll().filter((network: Network) => network.appId === appId);
}

export async function get(network: {
	name: string;
	appId: number;
}): Promise<Network> {
	const dockerNet = await docker
		.getNetwork(Network.generateDockerName(network.appId, network.name))
		.inspect();
	return Network.fromDockerNetwork(dockerNet);
}

export async function create(network: Network) {
	try {
		const existing = await get({
			name: network.name,
			appId: network.appId,
		});
		if (!network.isEqualConfig(existing)) {
			throw new ResourceRecreationAttemptError('network', network.name);
		}

		// We have a network with the same config and name
		// already created, we can skip this
	} catch (e) {
		if (!NotFoundError(e)) {
			logger.logSystemEvent(logTypes.createNetworkError, {
				network: { name: network.name, appId: network.appId },
				error: e,
			});
			throw e;
		}

		// If we got a not found error, create the network
		await network.create();
	}
}

export async function remove(network: Network) {
	// We simply forward this to the network object, but we
	// add this method to provide a consistent interface
	await network.remove();
}

export function supervisorNetworkReady(): Bluebird<boolean> {
	return Bluebird.resolve(
		fs.stat(`/sys/class/net/${constants.supervisorNetworkInterface}`),
	)
		.then(() => {
			return docker.getNetwork(constants.supervisorNetworkInterface).inspect();
		})
		.then((network) => {
			return (
				network.Options['com.docker.network.bridge.name'] ===
					constants.supervisorNetworkInterface &&
				network.IPAM.Config[0].Subnet === constants.supervisorNetworkSubnet &&
				network.IPAM.Config[0].Gateway === constants.supervisorNetworkGateway
			);
		})
		.catchReturn(NotFoundError, false)
		.catchReturn(ENOENT, false);
}

export function ensureSupervisorNetwork(): Bluebird<void> {
	const removeIt = () => {
		return Bluebird.resolve(
			docker.getNetwork(constants.supervisorNetworkInterface).remove(),
		).then(() => {
			return docker.getNetwork(constants.supervisorNetworkInterface).inspect();
		});
	};

	return Bluebird.resolve(
		docker.getNetwork(constants.supervisorNetworkInterface).inspect(),
	)
		.then((net) => {
			if (
				net.Options['com.docker.network.bridge.name'] !==
					constants.supervisorNetworkInterface ||
				net.IPAM.Config[0].Subnet !== constants.supervisorNetworkSubnet ||
				net.IPAM.Config[0].Gateway !== constants.supervisorNetworkGateway
			) {
				return removeIt();
			} else {
				return Bluebird.resolve(
					fs.stat(`/sys/class/net/${constants.supervisorNetworkInterface}`),
				)
					.catch(ENOENT, removeIt)
					.return();
			}
		})
		.catch(NotFoundError, () => {
			log.debug(`Creating ${constants.supervisorNetworkInterface} network`);
			return Bluebird.resolve(
				docker.createNetwork({
					Name: constants.supervisorNetworkInterface,
					Options: {
						'com.docker.network.bridge.name':
							constants.supervisorNetworkInterface,
					},
					IPAM: {
						Driver: 'default',
						Config: [
							{
								Subnet: constants.supervisorNetworkSubnet,
								Gateway: constants.supervisorNetworkGateway,
							},
						],
					},
				}),
			);
		});
}

function getWithBothLabels() {
	return Bluebird.join(
		docker.listNetworks({
			filters: {
				label: ['io.resin.supervised'],
			},
		}),
		docker.listNetworks({
			filters: {
				label: ['io.balena.supervised'],
			},
		}),
		(legacyNetworks, currentNetworks) => {
			return _.unionBy(currentNetworks, legacyNetworks, 'Id');
		},
	);
}
