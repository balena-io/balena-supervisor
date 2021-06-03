import * as Bluebird from 'bluebird';
import * as Dockerode from 'dockerode';
import { EventEmitter } from 'events';
import { isLeft } from 'fp-ts/lib/Either';
import * as JSONStream from 'JSONStream';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import StrictEventEmitter from 'strict-event-emitter-types';

import * as config from '../config';
import { docker } from '../lib/docker-utils';
import * as logger from '../logger';

import { PermissiveNumber } from '../config/types';
import constants = require('../lib/constants');
import {
	InternalInconsistencyError,
	NotFoundError,
	StatusCodeError,
} from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import { checkInt, isValidDeviceName } from '../lib/validation';
import { Service } from './service';
import { serviceNetworksToDockerNetworks } from './utils';

import log from '../lib/supervisor-console';
import logMonitor from '../logging/monitor';

interface ServiceManagerEvents {
	change: void;
}
type ServiceManagerEventEmitter = StrictEventEmitter<
	EventEmitter,
	ServiceManagerEvents
>;
const events: ServiceManagerEventEmitter = new EventEmitter();

interface KillOpts {
	removeContainer?: boolean;
	wait?: boolean;
}

export const on: typeof events['on'] = events.on.bind(events);
export const once: typeof events['once'] = events.once.bind(events);
export const removeListener: typeof events['removeListener'] = events.removeListener.bind(
	events,
);
export const removeAllListeners: typeof events['removeAllListeners'] = events.removeAllListeners.bind(
	events,
);

// Whether a container has died, indexed by ID
const containerHasDied: Dictionary<boolean> = {};
let listening = false;
// Volatile state of containers, indexed by containerId (or random strings if
// we don't yet have an id)
const volatileState: Dictionary<Partial<Service>> = {};

export const getAll = async (
	extraLabelFilters: string | string[] = [],
): Promise<Service[]> => {
	const filterLabels = ['supervised'].concat(extraLabelFilters);
	const containers = await listWithBothLabels(filterLabels);
	const services = await Bluebird.map(containers, async (container) => {
		try {
			const containerInfo = docker.getContainer(container.Id);
			const serviceInspect = await containerInfo.inspect();
			const service = Service.fromDockerContainer(serviceInspect);
			// We know that the containerId is set below, because `fromDockerContainer`
			// always sets it
			const vState = volatileState[service.containerId!];
			if (vState != null && vState.status != null) {
				service.status = vState.status;
			}
			return service;
		} catch (e) {
			if (NotFoundError(e)) {
				return null;
			}
			throw e;
		}
	});

	return services.filter((s) => s != null) as Service[];
};

export async function get(service: Service) {
	// Get the container ids for special network handling
	const containerIds = await getContainerIdMap(service.appId!);
	const services = (
		await getAll(`service-id=${service.serviceId}`)
	).filter((currentService) =>
		currentService.isEqualConfig(service, containerIds),
	);

	if (services.length === 0) {
		const e: StatusCodeError = new Error(
			'Could not find a container matching this service definition',
		);
		e.statusCode = 404;
		throw e;
	}
	return services[0];
}

export async function getStatus() {
	const services = await getAll();
	const status = _.clone(volatileState);

	for (const service of services) {
		if (service.containerId == null) {
			throw new InternalInconsistencyError(
				`containerId not defined in ServiceManager.getStatus: ${service}`,
			);
		}
		if (status[service.containerId] == null) {
			status[service.containerId] = _.pick(service, [
				'appId',
				'uuid',
				'imageId',
				'status',
				'releaseId',
				'commit',
				'createdAt',
				'serviceName',
			]) as Partial<Service>;
		}
	}

	return _.values(status);
}

export async function getByDockerContainerId(
	containerId: string,
): Promise<Service | null> {
	const container = await docker.getContainer(containerId).inspect();

	const { Labels } = container.Config;
	const isSupervised =
		!!Labels['io.balena.supervised'] || !!Labels['io.resin.supervised'];

	if (!isSupervised) {
		return null;
	}
	return Service.fromDockerContainer(container);
}

export async function updateMetadata(service: Service, target: Service) {
	const svc = await get(service);
	if (svc.containerId == null) {
		throw new InternalInconsistencyError(
			`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
		);
	}

	await docker.getContainer(svc.containerId).rename({
		name: `${service.serviceName}_${target.imageId}_${target.releaseId}`,
	});
}

export async function handover(current: Service, target: Service) {
	// We set the running container to not restart so that in case of a poweroff
	// it doesn't come back after boot.
	await prepareForHandover(current);
	await start(target);
	await waitToKill(
		current,
		target.config.labels['io.balena.update.handover-timeout'],
	);
	await kill(current);
}

export async function killAllLegacy(): Promise<void> {
	// Containers haven't been normalized (this is an updated supervisor)
	const supervisorImageId = (
		await docker.getImage(constants.supervisorImage).inspect()
	).Id;

	for (const container of await docker.listContainers({ all: true })) {
		if (container.ImageID !== supervisorImageId) {
			await killContainer(container.Id, {
				serviceName: 'legacy',
			});
		}
	}
}

export function kill(service: Service, opts: KillOpts = {}) {
	if (service.containerId == null) {
		throw new InternalInconsistencyError(
			`Attempt to kill container without containerId! Service :${service}`,
		);
	}
	return killContainer(service.containerId, service, opts);
}

export async function remove(service: Service) {
	logger.logSystemEvent(LogTypes.removeDeadService, { service });
	const existingService = await get(service);

	if (existingService.containerId == null) {
		throw new InternalInconsistencyError(
			`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
		);
	}

	try {
		await docker.getContainer(existingService.containerId).remove({ v: true });
	} catch (e) {
		if (!NotFoundError(e)) {
			logger.logSystemEvent(LogTypes.removeDeadServiceError, {
				service,
				error: e,
			});
			throw e;
		}
	}
}
export function getAllByAppId(appId: number) {
	return getAll(`app-id=${appId}`);
}

export async function stopAllByAppId(appId: number) {
	for (const app of await getAllByAppId(appId)) {
		await kill(app, { removeContainer: false });
	}
}

export async function create(service: Service) {
	const mockContainerId = config.newUniqueKey();
	try {
		const existing = await get(service);
		if (existing.containerId == null) {
			throw new InternalInconsistencyError(
				`No containerId provided for service ${service.serviceName} in ServiceManager.updateMetadata. Service: ${service}`,
			);
		}
		return docker.getContainer(existing.containerId);
	} catch (e) {
		if (!NotFoundError(e)) {
			logger.logSystemEvent(LogTypes.installServiceError, {
				service,
				error: e,
			});
			throw e;
		}

		const deviceName = await config.get('name');
		if (!isValidDeviceName(deviceName)) {
			throw new Error(
				'The device name contains a newline, which is unsupported by balena. ' +
					'Please fix the device name',
			);
		}

		// Get all created services so far
		if (service.appId == null) {
			throw new InternalInconsistencyError(
				'Attempt to start a service without an existing application ID',
			);
		}
		const serviceContainerIds = await getContainerIdMap(service.appId);
		const conf = service.toDockerContainer({
			deviceName,
			containerIds: serviceContainerIds,
		});
		const nets = serviceNetworksToDockerNetworks(service.extraNetworksToJoin());

		logger.logSystemEvent(LogTypes.installService, { service });
		reportNewStatus(mockContainerId, service, 'Installing');

		const container = await docker.createContainer(conf);
		service.containerId = container.id;

		await Promise.all(
			_.map((nets || {}).EndpointsConfig, (endpointConfig, name) =>
				docker.getNetwork(name).connect({
					Container: container.id,
					EndpointConfig: endpointConfig,
				}),
			),
		);

		logger.logSystemEvent(LogTypes.installServiceSuccess, { service });
		return container;
	} finally {
		reportChange(mockContainerId);
	}
}

export async function start(service: Service) {
	let alreadyStarted = false;
	let containerId: string | null = null;

	try {
		const container = await create(service);
		containerId = container.id;
		logger.logSystemEvent(LogTypes.startService, { service });

		reportNewStatus(containerId, service, 'Starting');

		let shouldRemove = false;
		let err: Error | undefined;
		try {
			await container.start();
		} catch (e) {
			// Get the statusCode from the original cause and make sure it's
			// definitely an int for comparison reasons
			const maybeStatusCode = PermissiveNumber.decode(e.statusCode);
			if (isLeft(maybeStatusCode)) {
				shouldRemove = true;
				err = new Error(`Could not parse status code from docker error:  ${e}`);
				throw err;
			}
			const statusCode = maybeStatusCode.right;
			const message = e.message;

			// 304 means the container was already started, precisely what we want
			if (statusCode === 304) {
				alreadyStarted = true;
			} else if (
				statusCode === 500 &&
				_.isString(message) &&
				message.trim().match(/exec format error$/)
			) {
				// Provide a friendlier error message for "exec format error"
				const deviceType = await config.get('deviceType');
				err = new Error(
					`Application architecture incompatible with ${deviceType}: exec format error`,
				);
				throw err;
			} else {
				// rethrow the same error
				err = e;
				throw e;
			}
		} finally {
			if (shouldRemove) {
				// If starting the container fialed, we remove it so that it doesn't litter
				await container.remove({ v: true }).catch(_.noop);
				logger.logSystemEvent(LogTypes.startServiceError, {
					service,
					error: err,
				});
			}
		}

		const serviceId = service.serviceId;
		const imageId = service.imageId;
		if (serviceId == null || imageId == null) {
			throw new InternalInconsistencyError(
				`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.start`,
			);
		}

		logger.attach(container.id, { serviceId, imageId });

		if (!alreadyStarted) {
			logger.logSystemEvent(LogTypes.startServiceSuccess, { service });
		}

		service.config.running = true;
		return container;
	} finally {
		if (containerId != null) {
			reportChange(containerId);
		}
	}
}

export function listenToEvents() {
	if (listening) {
		return;
	}

	listening = true;

	const listen = async () => {
		const stream = await docker.getEvents({
			filters: { type: ['container'] } as any,
		});

		stream.on('error', (e) => {
			log.error(`Error on docker events stream:`, e);
		});
		const parser = JSONStream.parse();
		parser.on('data', async (data: { status: string; id: string }) => {
			if (data != null) {
				const status = data.status;
				if (status === 'die' || status === 'start' || status === 'destroy') {
					try {
						let service: Service | null = null;
						try {
							service = await getByDockerContainerId(data.id);
						} catch (e) {
							if (!NotFoundError(e)) {
								throw e;
							}
						}
						if (service != null) {
							events.emit('change');
							if (status === 'die') {
								logger.logSystemEvent(LogTypes.serviceExit, { service });
								containerHasDied[data.id] = true;
							} else if (status === 'start' && containerHasDied[data.id]) {
								delete containerHasDied[data.id];
								logger.logSystemEvent(LogTypes.serviceRestart, {
									service,
								});

								const serviceId = service.serviceId;
								const imageId = service.imageId;
								if (serviceId == null || imageId == null) {
									throw new InternalInconsistencyError(
										`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.listenToEvents`,
									);
								}
								logger.attach(data.id, {
									serviceId,
									imageId,
								});
							} else if (status === 'destroy') {
								await logMonitor.detach(data.id);
							}
						}
					} catch (e) {
						log.error('Error on docker event:', e, e.stack);
					}
				}
			}
		});

		return new Promise((resolve, reject) => {
			parser
				.on('error', (e: Error) => {
					log.error('Error on docker events stream:', e);
					reject(e);
				})
				.on('end', resolve);
			stream.pipe(parser);
		});
	};

	Bluebird.resolve(listen())
		.catch((e) => {
			log.error('Error listening to events:', e, e.stack);
		})
		.finally(() => {
			listening = false;
			setTimeout(listenToEvents, 1000);
		});

	return;
}

export async function attachToRunning() {
	const services = await getAll();
	for (const service of services) {
		if (service.status === 'Running') {
			const serviceId = service.serviceId;
			const imageId = service.imageId;
			if (serviceId == null || imageId == null) {
				throw new InternalInconsistencyError(
					`serviceId and imageId not defined for service: ${service.serviceName} in ServiceManager.start`,
				);
			}

			if (service.containerId == null) {
				throw new InternalInconsistencyError(
					`containerId not defined for service: ${service.serviceName} in ServiceManager.attachToRunning`,
				);
			}
			logger.attach(service.containerId, {
				serviceId,
				imageId,
			});
		}
	}
}

export async function getContainerIdMap(
	appId: number,
): Promise<Dictionary<string>> {
	return _(await getAllByAppId(appId))
		.keyBy('serviceName')
		.mapValues('containerId')
		.value() as Dictionary<string>;
}

function reportChange(containerId?: string, status?: Partial<Service>) {
	if (containerId != null) {
		if (status != null) {
			volatileState[containerId] = { ...status };
		} else if (volatileState[containerId] != null) {
			delete volatileState[containerId];
		}
	}
	events.emit('change');
}

function reportNewStatus(
	containerId: string,
	service: Partial<Service>,
	status: string,
) {
	reportChange(
		containerId,
		_.merge(
			{ status },
			_.pick(service, ['imageId', 'appId', 'releaseId', 'commit']),
		),
	);
}

function killContainer(
	containerId: string,
	service: Partial<Service> = {},
	{ removeContainer = true, wait = false }: KillOpts = {},
): Bluebird<void> {
	// To maintain compatibility of the `wait` flag, this function is not
	// async, but it feels like whether or not the promise should be waited on
	// should performed by the caller
	// TODO: Remove the need for the wait flag

	return Bluebird.try(() => {
		logger.logSystemEvent(LogTypes.stopService, { service });
		if (service.imageId != null) {
			reportNewStatus(containerId, service, 'Stopping');
		}

		const containerObj = docker.getContainer(containerId);
		const killPromise = Bluebird.resolve(containerObj.stop())
			.then(() => {
				if (removeContainer) {
					return containerObj.remove({ v: true });
				}
			})
			.catch((e) => {
				// Get the statusCode from the original cause and make sure it's
				// definitely an int for comparison reasons
				const maybeStatusCode = PermissiveNumber.decode(e.statusCode);
				if (isLeft(maybeStatusCode)) {
					throw new Error(
						`Could not parse status code from docker error:  ${e}`,
					);
				}
				const statusCode = maybeStatusCode.right;

				// 304 means the container was already stopped, so we can just remove it
				if (statusCode === 304) {
					logger.logSystemEvent(LogTypes.stopServiceNoop, { service });
					// Why do we attempt to remove the container again?
					if (removeContainer) {
						return containerObj.remove({ v: true });
					}
				} else if (statusCode === 404) {
					// 404 means the container doesn't exist, precisely what we want!
					logger.logSystemEvent(LogTypes.stopRemoveServiceNoop, {
						service,
					});
				} else {
					throw e;
				}
			})
			.tap(() => {
				delete containerHasDied[containerId];
				logger.logSystemEvent(LogTypes.stopServiceSuccess, { service });
			})
			.catch((e) => {
				logger.logSystemEvent(LogTypes.stopServiceError, {
					service,
					error: e,
				});
			})
			.finally(() => {
				if (service.imageId != null) {
					reportChange(containerId);
				}
			});

		if (wait) {
			return killPromise;
		}
		return;
	});
}

async function listWithBothLabels(
	labelList: string[],
): Promise<Dockerode.ContainerInfo[]> {
	const listWithPrefix = (prefix: string) =>
		docker.listContainers({
			all: true,
			filters: {
				label: _.map(labelList, (v) => `${prefix}${v}`),
			},
		});

	const [legacy, current] = await Promise.all([
		listWithPrefix('io.resin.'),
		listWithPrefix('io.balena.'),
	]);

	return _.unionBy(legacy, current, 'Id');
}

async function prepareForHandover(service: Service) {
	const svc = await get(service);
	if (svc.containerId == null) {
		throw new InternalInconsistencyError(
			`No containerId provided for service ${service.serviceName} in ServiceManager.prepareForHandover. Service: ${service}`,
		);
	}
	const container = docker.getContainer(svc.containerId);
	await container.update({ RestartPolicy: {} });
	return await container.rename({
		name: `old_${service.serviceName}_${service.imageId}_${service.imageId}_${service.releaseId}`,
	});
}

function waitToKill(service: Service, timeout: number | string) {
	const pollInterval = 100;
	timeout = checkInt(timeout, { positive: true }) || 60000;
	const deadline = Date.now() + timeout;

	const handoverCompletePaths = service.handoverCompleteFullPathsOnHost();

	const wait = (): Bluebird<void> =>
		Bluebird.any(
			handoverCompletePaths.map((file) =>
				fs.stat(file).then(() => fs.unlink(file).catch(_.noop)),
			),
		).catch(async () => {
			if (Date.now() < deadline) {
				await Bluebird.delay(pollInterval);
				return wait();
			} else {
				log.info(
					`Handover timeout has passed, assuming handover was completed for service ${service.serviceName}`,
				);
			}
		});

	log.info(
		`Waiting for handover to be completed for service: ${service.serviceName}`,
	);

	return wait().then(() => {
		log.success(`Handover complete for service ${service.serviceName}`);
	});
}
