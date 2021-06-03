import * as express from 'express';
import * as _ from 'lodash';

import * as config from '../config';
import { transaction, Transaction } from '../db';
import * as dbFormat from '../device-state/db-format';
import { validateTargetContracts } from '../lib/contracts';
import constants = require('../lib/constants');
import { docker } from '../lib/docker-utils';
import * as logger from '../logger';
import log from '../lib/supervisor-console';
import LocalModeManager from '../local-mode';
import {
	ContractViolationError,
	InternalInconsistencyError,
} from '../lib/errors';
import StrictEventEmitter from 'strict-event-emitter-types';

import App from './app';
import * as volumeManager from './volume-manager';
import * as networkManager from './network-manager';
import * as serviceManager from './service-manager';
import * as imageManager from './images';
import type { Image } from './images';
import { getExecutors, CompositionStepT } from './composition-steps';
import * as commitStore from './commit';

import Service from './service';

import { createV1Api } from '../device-api/v1';
import { createV2Api } from '../device-api/v2';
import { CompositionStep, generateStep } from './composition-steps';
import {
	InstancedAppState,
	TargetApplications,
	DeviceStatus,
	DeviceReportFields,
} from '../types/state';
import { checkTruthy, checkInt } from '../lib/validation';
import { Proxyvisor } from '../proxyvisor';
import * as updateLock from '../lib/update-lock';
import { EventEmitter } from 'events';
import Network from './network';
import Volume from './volume';

type ApplicationManagerEventEmitter = StrictEventEmitter<
	EventEmitter,
	{ change: DeviceReportFields }
>;
const events: ApplicationManagerEventEmitter = new EventEmitter();
export const on: typeof events['on'] = events.on.bind(events);
export const once: typeof events['once'] = events.once.bind(events);
export const removeListener: typeof events['removeListener'] = events.removeListener.bind(
	events,
);
export const removeAllListeners: typeof events['removeAllListeners'] = events.removeAllListeners.bind(
	events,
);

const proxyvisor = new Proxyvisor();
const localModeManager = new LocalModeManager();

export const router = (() => {
	const $router = express.Router();
	$router.use(express.urlencoded({ extended: true, limit: '10mb' }));
	$router.use(express.json({ limit: '10mb' }));

	createV1Api($router);
	createV2Api($router);

	$router.use(proxyvisor.router);

	return $router;
})();

// We keep track of the containers we've started, to avoid triggering successive start
// requests for a container
export let containerStarted: { [containerId: string]: boolean } = {};
export let fetchesInProgress = 0;
export let timeSpentFetching = 0;

// In the case of intermediate target apply, toggle to true to avoid unintended image deletion
let isApplyingIntermediate = false;

export function setIsApplyingIntermediate(value: boolean = false) {
	isApplyingIntermediate = value;
}

export function resetTimeSpentFetching(value: number = 0) {
	timeSpentFetching = value;
}

const actionExecutors = getExecutors({
	lockFn: lockingIfNecessary,
	callbacks: {
		containerStarted: (id: string) => {
			containerStarted[id] = true;
		},
		containerKilled: (id: string) => {
			delete containerStarted[id];
		},
		fetchStart: () => {
			fetchesInProgress += 1;
		},
		fetchEnd: () => {
			fetchesInProgress -= 1;
		},
		fetchTime: (time) => {
			timeSpentFetching += time;
		},
		stateReport: (state) => {
			reportCurrentState(state);
		},
		bestDeltaSource,
	},
});

export const validActions = Object.keys(actionExecutors);

// Volatile state for a single container. This is used for temporarily setting a
// different state for a container, such as running: false
let targetVolatilePerImageId: {
	[imageId: number]: Partial<Service['config']>;
} = {};

export const initialized = (async () => {
	await config.initialized;

	await imageManager.initialized;
	await imageManager.cleanupDatabase();
	const cleanup = async () => {
		const containers = await docker.listContainers({ all: true });
		await logger.clearOutOfDateDBLogs(_.map(containers, 'Id'));
	};

	// Rather than relying on removing out of date database entries when we're no
	// longer using them, set a task that runs periodically to clear out the database
	// This has the advantage that if for some reason a container is removed while the
	// supervisor is down, we won't have zombie entries in the db

	// Once a day
	setInterval(cleanup, 1000 * 60 * 60 * 24);
	// But also run it in on startup
	await cleanup();

	await localModeManager.init();
	await serviceManager.attachToRunning();
	serviceManager.listenToEvents();

	imageManager.on('change', reportCurrentState);
	serviceManager.on('change', reportCurrentState);
})();

export function getDependentState() {
	return proxyvisor.getCurrentStates();
}

function reportCurrentState(data?: Partial<InstancedAppState>) {
	events.emit('change', data ?? {});
}

export async function lockingIfNecessary<T extends unknown>(
	appId: number,
	{ force = false, skipLock = false } = {},
	fn: () => Resolvable<T>,
) {
	if (skipLock) {
		return fn();
	}
	const lockOverride = (await config.get('lockOverride')) || force;
	return updateLock.lock(
		appId,
		{ force: lockOverride },
		fn as () => PromiseLike<void>,
	);
}

export async function getRequiredSteps(
	targetApps: InstancedAppState,
	ignoreImages: boolean = false,
): Promise<CompositionStep[]> {
	// get some required data
	const [
		{ localMode, delta },
		downloading,
		cleanupNeeded,
		availableImages,
		currentApps,
	] = await Promise.all([
		config.getMany(['localMode', 'delta']),
		imageManager.getDownloadingImageIds(),
		imageManager.isCleanupNeeded(),
		imageManager.getAvailable(),
		getCurrentApps(),
	]);
	const containerIdsByAppId = await getAppContainerIds(currentApps);

	if (localMode) {
		ignoreImages = localMode;
	}

	const currentAppIds = Object.keys(currentApps).map((i) => parseInt(i, 10));
	const targetAppIds = Object.keys(targetApps).map((i) => parseInt(i, 10));

	let steps: CompositionStep[] = [];

	// First check if we need to create the supervisor network
	if (!(await networkManager.supervisorNetworkReady())) {
		// If we do need to create it, we first need to kill any services using the api
		const killSteps = steps.concat(killServicesUsingApi(currentApps));
		if (killSteps.length > 0) {
			steps = steps.concat(killSteps);
		} else {
			steps.push({ action: 'ensureSupervisorNetwork' });
		}
	} else {
		if (!localMode && downloading.length === 0 && !isApplyingIntermediate) {
			// Avoid cleaning up dangling images while purging
			if (cleanupNeeded) {
				steps.push({ action: 'cleanup' });
			}

			// Detect any images which must be saved/removed, except when purging,
			// as we only want to remove containers, remove volumes, create volumes
			// anew, and start containers without images being removed.
			steps = steps.concat(
				saveAndRemoveImages(
					currentApps,
					targetApps,
					availableImages,
					localMode,
				),
			);
		}

		// We want to remove images before moving on to anything else
		if (steps.length === 0) {
			const targetAndCurrent = _.intersection(currentAppIds, targetAppIds);
			const onlyTarget = _.difference(targetAppIds, currentAppIds);
			const onlyCurrent = _.difference(currentAppIds, targetAppIds);

			// For apps that exist in both current and target state, calculate what we need to
			// do to move to the target state
			for (const id of targetAndCurrent) {
				steps = steps.concat(
					currentApps[id].nextStepsForAppUpdate(
						{
							localMode,
							availableImages,
							containerIds: containerIdsByAppId[id],
							downloading,
						},
						targetApps[id],
					),
				);
			}

			// For apps in the current state but not target, we call their "destructor"
			for (const id of onlyCurrent) {
				steps = steps.concat(
					await currentApps[id].stepsToRemoveApp({
						localMode,
						downloading,
						containerIds: containerIdsByAppId[id],
					}),
				);
			}

			// For apps in the target state but not the current state, we generate steps to
			// create the app by mocking an existing app which contains nothing
			for (const id of onlyTarget) {
				const { appId, uuid } = targetApps[id];
				const emptyCurrent = new App(
					{
						appId,
						uuid,
						services: [],
						volumes: {},
						networks: {},
					},
					false,
				);
				steps = steps.concat(
					emptyCurrent.nextStepsForAppUpdate(
						{
							localMode,
							availableImages,
							containerIds: containerIdsByAppId[id] ?? {},
							downloading,
						},
						targetApps[id],
					),
				);
			}
		}
	}

	const newDownloads = steps.filter((s) => s.action === 'fetch').length;
	if (!ignoreImages && delta && newDownloads > 0) {
		// Check that this is not the first pull for an
		// application, as we want to download all images then
		// Otherwise we want to limit the downloading of
		// deltas to constants.maxDeltaDownloads
		const appImages = _.groupBy(availableImages, 'appId');
		let downloadsToBlock =
			downloading.length + newDownloads - constants.maxDeltaDownloads;

		steps = steps.filter((step) => {
			if (step.action === 'fetch' && downloadsToBlock > 0) {
				const imagesForThisApp =
					appImages[(step as CompositionStepT<'fetch'>).image.appId];
				if (imagesForThisApp == null || imagesForThisApp.length === 0) {
					// There isn't a valid image for the fetch
					// step, so we keep it
					return true;
				} else {
					downloadsToBlock -= 1;
					return false;
				}
			} else {
				return true;
			}
		});
	}

	if (!ignoreImages && steps.length === 0 && downloading.length > 0) {
		// We want to keep the state application alive
		steps.push(generateStep('noop', {}));
	}

	steps = steps.concat(
		await proxyvisor.getRequiredSteps(
			availableImages,
			downloading,
			currentApps,
			targetApps,
			steps,
		),
	);

	return steps;
}

export async function stopAll({ force = false, skipLock = false } = {}) {
	const services = await serviceManager.getAll();
	await Promise.all(
		services.map(async (s) => {
			return lockingIfNecessary(s.appId, { force, skipLock }, async () => {
				await serviceManager.kill(s, { removeContainer: false, wait: true });
				if (s.containerId) {
					delete containerStarted[s.containerId];
				}
			});
		}),
	);
}

export async function getCurrentAppsForReport(): Promise<
	NonNullable<DeviceStatus['local']>['apps']
> {
	const apps = await getCurrentApps();

	const appsToReport: NonNullable<DeviceStatus['local']>['apps'] = {};
	for (const appId of Object.getOwnPropertyNames(apps)) {
		appsToReport[appId] = {
			services: {},
		};
	}

	return appsToReport;
}

// The following two function may look pretty odd, but after the move to uuids,
// there's a chance that the current running apps don't have a uuid set. We
// still need to be able to work on these and perform various state changes. To
// do this we try to use the UUID to group the components, and if that isn't
// available we revert to using the appIds instead
export async function getCurrentApps(): Promise<InstancedAppState> {
	const componentGroups = groupComponents(
		await serviceManager.getAll(),
		await networkManager.getAll(),
		await volumeManager.getAll(),
	);

	const apps: InstancedAppState = {};
	for (const strAppId of Object.keys(componentGroups)) {
		const appId = parseInt(strAppId, 10);

		// TODO: get commit and release version from container
		const commit = await commitStore.getCommitForApp(appId);

		const components = componentGroups[appId];

		// fetch the correct uuid from any component within the appId
		const uuid = [
			components.services[0]?.uuid,
			components.volumes[0]?.uuid,
			components.networks[0]?.uuid,
		]
			.filter((u) => u != null)
			.shift()!;

		// If we don't have any components for this app, ignore it (this can
		// actually happen when moving between backends but maintaining UUIDs)
		if (
			!_.isEmpty(components.services) ||
			!_.isEmpty(components.volumes) ||
			!_.isEmpty(components.networks)
		) {
			apps[appId] = new App(
				{
					appId,
					uuid,
					commit,
					services: componentGroups[appId].services,
					networks: _.keyBy(componentGroups[appId].networks, 'name'),
					volumes: _.keyBy(componentGroups[appId].volumes, 'name'),
				},
				false,
			);
		}
	}

	return apps;
}

interface AppGroup {
	[appId: number]: {
		services: Service[];
		volumes: Volume[];
		networks: Network[];
	};
}

function groupComponents(
	services: Service[],
	networks: Network[],
	volumes: Volume[],
): AppGroup {
	const grouping: AppGroup = {};

	const everyComponent: [{ uuid?: string; appId: number }] = [
		...services,
		...networks,
		...volumes,
	] as any;

	const allUuids: string[] = [];
	const allAppIds: number[] = [];
	everyComponent.forEach(({ appId, uuid }) => {
		// Pre-populate the groupings
		grouping[appId] = {
			services: [],
			networks: [],
			volumes: [],
		};
		// Save all the uuids for later
		if (uuid != null) {
			allUuids.push(uuid);
		}
		allAppIds.push(appId);
	});

	// First we try to group everything by it's uuid, but if any component does
	// not have a uuid, we fall back to the old appId style
	if (everyComponent.length === allUuids.length) {
		const uuidGroups: { [uuid: string]: AppGroup[0] } = {};
		_.uniq(allUuids).forEach((uuid) => {
			const uuidServices = services.filter(({ uuid: sUuid }) => uuid === sUuid);
			const uuidVolumes = volumes.filter(({ uuid: vUuid }) => uuid === vUuid);
			const uuidNetworks = networks.filter(({ uuid: nUuid }) => uuid === nUuid);

			uuidGroups[uuid] = {
				services: uuidServices,
				networks: uuidNetworks,
				volumes: uuidVolumes,
			};
		});

		for (const uuid of Object.keys(uuidGroups)) {
			// There's a chance that the uuid and the appId is different, and this
			// is fine. Unfortunately we have no way of knowing which is the "real"
			// appId (that is the app id which relates to the currently joined
			// backend) so we instead just choose the first and add everything to that
			const appId =
				uuidGroups[uuid].services[0]?.appId ||
				uuidGroups[uuid].networks[0]?.appId ||
				uuidGroups[uuid].volumes[0]?.appId;
			grouping[appId] = uuidGroups[uuid];
		}
	} else {
		// Otherwise group them by appId and let the state engine match them later.
		// This will only happen once, as every target state going forward will
		// contain UUIDs, we just need to handle the initial upgrade
		const appSvcs = _.groupBy(services, 'appId');
		const appVols = _.groupBy(volumes, 'appId');
		const appNets = _.groupBy(networks, 'appId');

		_.uniq(allAppIds).forEach((appId) => {
			grouping[appId].services = grouping[appId].services.concat(
				appSvcs[appId] || [],
			);
			grouping[appId].networks = grouping[appId].networks.concat(
				appNets[appId] || [],
			);
			grouping[appId].volumes = grouping[appId].volumes.concat(
				appVols[appId] || [],
			);
		});
	}

	return grouping;
}

function killServicesUsingApi(current: InstancedAppState): CompositionStep[] {
	const steps: CompositionStep[] = [];
	_.each(current, (app) => {
		_.each(app.services, (service) => {
			const isUsingSupervisorAPI = checkTruthy(
				service.config.labels['io.balena.features.supervisor-api'],
			);
			if (!isUsingSupervisorAPI) {
				// No need to stop service as it's not using the Supervisor's API
				return steps;
			}
			if (service.status !== 'Stopping') {
				// Stop this service
				steps.push(generateStep('kill', { current: service }));
			} else if (service.status === 'Stopping') {
				// Wait for the service to finish stopping
				steps.push(generateStep('noop', {}));
			}
		});
	});
	return steps;
}

export async function executeStep(
	step: CompositionStep,
	{ force = false, skipLock = false } = {},
): Promise<void> {
	if (proxyvisor.validActions.includes(step.action)) {
		return proxyvisor.executeStepAction(step);
	}

	if (!validActions.includes(step.action)) {
		return Promise.reject(
			new InternalInconsistencyError(
				`Invalid composition step action: ${step.action}`,
			),
		);
	}

	// TODO: Find out why this needs to be cast, the typings should hold true
	await actionExecutors[step.action]({
		...step,
		force,
		skipLock,
	} as any);
}

// FIXME: This shouldn't be in this module
export async function setTarget(
	apps: TargetApplications,
	dependent: any,
	source: string,
	maybeTrx?: Transaction,
) {
	const setInTransaction = async (
		$filteredApps: TargetApplications,
		trx: Transaction,
	) => {
		await dbFormat.setApps($filteredApps, source, trx);
		await trx('app')
			.where({ source })
			.whereNotIn(
				'appId',
				// Use apps here, rather than filteredApps, to
				// avoid removing a release from the database
				// without an application to replace it.
				// Currently this will only happen if the release
				// which would replace it fails a contract
				// validation check
				_.map(apps, (a) => checkInt(a.appId)),
			)
			.whereNotIn(
				'uuid',
				_.map(apps, (_a, uuid) => uuid),
			)
			.del();
		await proxyvisor.setTargetInTransaction(dependent, trx);
	};

	// We look at the container contracts here, as if we
	// cannot run the release, we don't want it to be added
	// to the database, overwriting the current release. This
	// is because if we just reject the release, but leave it
	// in the db, if for any reason the current state stops
	// running, we won't restart it, leaving the device
	// useless - The exception to this rule is when the only
	// failing services are marked as optional, then we
	// filter those out and add the target state to the database
	const contractViolators: { [appName: string]: string[] } = {};
	const fulfilledContracts = validateTargetContracts(apps);
	const filteredApps = _.cloneDeep(apps);
	_.each(
		fulfilledContracts,
		({ valid, unmetServices, fulfilledServices, unmetAndOptional }, appId) => {
			if (!valid) {
				contractViolators[apps[appId].name] = unmetServices;
				return delete filteredApps[appId];
			} else {
				// valid is true, but we could still be missing
				// some optional containers, and need to filter
				// these out of the target state
				filteredApps[appId].services = _.pickBy(
					filteredApps[appId].services,
					({ serviceName }) => fulfilledServices.includes(serviceName),
				);
				if (unmetAndOptional.length !== 0) {
					return reportOptionalContainers(unmetAndOptional);
				}
			}
		},
	);
	let promise;
	if (maybeTrx != null) {
		promise = setInTransaction(filteredApps, maybeTrx);
	} else {
		promise = transaction((trx) => setInTransaction(filteredApps, trx));
	}
	await promise;
	targetVolatilePerImageId = {};
	if (!_.isEmpty(contractViolators)) {
		throw new ContractViolationError(contractViolators);
	}
}

export async function getTargetApps(): Promise<TargetApplications> {
	const apps = await dbFormat.getTargetJson();

	// Whilst it may make sense here to return the target state generated from the
	// internal instanced representation that we have, we make irreversable
	// changes to the input target state to avoid having undefined entries into
	// the instances throughout the supervisor. The target state is derived from
	// the database entries anyway, so these two things should never be different
	// (except for the volatile state)

	_.each(apps, (app) => {
		if (!_.isEmpty(app.services)) {
			app.services = _.mapValues(app.services, (svc) => {
				if (svc.imageId && targetVolatilePerImageId[svc.imageId] != null) {
					return { ...svc, ...targetVolatilePerImageId };
				}
				return svc;
			});
		}
	});

	return apps;
}

export function setTargetVolatileForService(
	imageId: number,
	target: Partial<Service['config']>,
) {
	if (targetVolatilePerImageId[imageId] == null) {
		targetVolatilePerImageId = {};
	}
	targetVolatilePerImageId[imageId] = target;
}

export function clearTargetVolatileForServices(imageIds: number[]) {
	for (const imageId of imageIds) {
		targetVolatilePerImageId[imageId] = {};
	}
}

export function getDependentTargets() {
	return proxyvisor.getTarget();
}

export async function serviceNameFromId(serviceId: number) {
	// We get the target here as it shouldn't matter, and getting the target is cheaper
	const targets = await getTargetApps();
	for (const appId of Object.keys(targets)) {
		const app = targets[parseInt(appId, 10)];
		const service = _.find(app.services, { serviceId });
		if (service?.serviceName === null) {
			throw new InternalInconsistencyError(
				`Could not find a service name for id: ${serviceId}`,
			);
		}
		return service!.serviceName;
	}
	throw new InternalInconsistencyError(
		`Could not find a service for id: ${serviceId}`,
	);
}

export function localModeSwitchCompletion() {
	return localModeManager.switchCompletion();
}

export function bestDeltaSource(
	image: Image,
	available: Image[],
): string | null {
	if (!image.dependent) {
		for (const availableImage of available) {
			if (
				availableImage.serviceName === image.serviceName &&
				availableImage.appId === image.appId
			) {
				return availableImage.name;
			}
		}
	}
	for (const availableImage of available) {
		if (availableImage.appId === image.appId) {
			return availableImage.name;
		}
	}
	return null;
}

// We need to consider images for all apps, and not app-by-app, so we handle this here,
// rather than in the App class
// TODO: This function was taken directly from the old application manager, because it's
// complex enough that it's not really worth changing this along with the rest of the
// application-manager class. We should make this function much less opaque.
// Ideally we'd have images saved against specific apps, and those apps handle the
// lifecycle of said image
function saveAndRemoveImages(
	current: InstancedAppState,
	target: InstancedAppState,
	availableImages: imageManager.Image[],
	localMode: boolean,
): CompositionStep[] {
	const imageForService = (service: Service): imageManager.Image => ({
		name: service.imageName!,
		appId: service.appId,
		serviceId: service.serviceId!,
		serviceName: service.serviceName!,
		imageId: service.imageId!,
		releaseId: service.releaseId!,
		dependent: 0,
	});
	type ImageWithoutID = Omit<imageManager.Image, 'dockerImageId' | 'id'>;

	// imagesToRemove: images that
	// - are not used in the current state, and
	// - are not going to be used in the target state, and
	// - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
	// imagesToSave: images that
	// - are locally available (i.e. an image with the same digest exists)
	// - are not saved to the DB with all their metadata (serviceId, serviceName, etc)

	const allImageDockerIdsForTargetApp = (app: App) =>
		_(app.services)
			.map((svc) => [svc.imageName, svc.config.image])
			.filter((img) => img[1] != null)
			.value();

	const availableWithoutIds: ImageWithoutID[] = _.map(
		availableImages,
		(image) => _.omit(image, ['dockerImageId', 'id']),
	);

	const currentImages = _.flatMap(current, (app) =>
		_.map(
			app.services,
			(svc) =>
				_.find(availableImages, {
					dockerImageId: svc.config.image,
					imageId: svc.imageId,
				}) ?? _.find(availableImages, { dockerImageId: svc.config.image }),
		),
	) as imageManager.Image[];
	const targetImages = _.flatMap(target, (app) =>
		_.map(app.services, imageForService),
	);

	const availableAndUnused = _.filter(
		availableImages,
		(image) =>
			!_.some(currentImages.concat(targetImages), (imageInUse) => {
				return (
					imageManager.isSameImage(image, imageInUse) ||
					image.id === imageInUse?.id ||
					image.dockerImageId === imageInUse?.dockerImageId
				);
			}),
	);

	const imagesToDownload = _.filter(
		targetImages,
		(targetImage) =>
			!_.some(availableImages, (available) =>
				imageManager.isSameImage(available, targetImage),
			),
	);

	const targetImageDockerIds = _.fromPairs(
		_.flatMap(target, allImageDockerIdsForTargetApp),
	);

	// Images that are available but we don't have them in the DB with the exact metadata:
	let imagesToSave: imageManager.Image[] = [];
	if (!localMode) {
		imagesToSave = _.filter(targetImages, (targetImage) => {
			const isActuallyAvailable = _.some(availableImages, (availableImage) => {
				if (imageManager.isSameImage(availableImage, targetImage)) {
					return true;
				}
				if (
					availableImage.dockerImageId ===
					targetImageDockerIds[targetImage.name]
				) {
					return true;
				}
				return false;
			});
			const isNotSaved = !_.some(availableWithoutIds, (img) =>
				_.isEqual(img, targetImage),
			);
			return isActuallyAvailable && isNotSaved;
		});
	}

	const deltaSources = _.map(imagesToDownload, (image) => {
		return bestDeltaSource(image, availableImages);
	});
	const proxyvisorImages = proxyvisor.imagesInUse(current, target);

	const potentialDeleteThenDownload = _(current)
		.flatMap((app) => _.values(app.services))
		.filter(
			(svc) =>
				svc.config.labels['io.balena.update.strategy'] ===
					'delete-then-download' && svc.status === 'Stopped',
		)
		.value();

	const imagesToRemove = _.filter(
		availableAndUnused.concat(potentialDeleteThenDownload.map(imageForService)),
		(image) => {
			const notUsedForDelta = !_.includes(deltaSources, image.name);
			const notUsedByProxyvisor = !_.some(proxyvisorImages, (proxyvisorImage) =>
				imageManager.isSameImage(image, {
					name: proxyvisorImage,
				}),
			);
			// TODO: possibly add hostapps and supervisor to these filter
			return notUsedForDelta && notUsedByProxyvisor;
		},
	);

	return imagesToSave
		.map((image) => ({ action: 'saveImage', image } as CompositionStep))
		.concat(imagesToRemove.map((image) => ({ action: 'removeImage', image })));
}

async function getAppContainerIds(currentApps: InstancedAppState) {
	const containerIds: { [appId: number]: Dictionary<string> } = {};
	await Promise.all(
		_.map(currentApps, async (_app, appId) => {
			const intAppId = parseInt(appId, 10);
			containerIds[intAppId] = await serviceManager.getContainerIdMap(intAppId);
		}),
	);

	return containerIds;
}

function reportOptionalContainers(serviceNames: string[]) {
	// Print logs to the console and dashboard, letting the
	// user know that we're not going to run certain services
	// because of their contract
	const message = `Not running containers because of contract violations: ${serviceNames.join(
		'. ',
	)}`;
	log.info(message);
	return logger.logSystemMessage(
		message,
		{},
		'optionalContainerViolation',
		true,
	);
}

// FIXME: This would be better to implement using the App class, and have each one
// generate its status. For now we use the original from application-manager.coffee.
export async function getStatus() {
	const [services, images] = await Promise.all([
		serviceManager.getStatus(),
		imageManager.getStatus(),
	]);

	const apps: Dictionary<any> = {};
	const dependent: Dictionary<any> = {};
	let releaseId: number | boolean | null | undefined = null; // ????
	const creationTimesAndReleases: Dictionary<any> = {};
	// We iterate over the current running services and add them to the current state
	// of the app they belong to.
	for (const service of services) {
		const { appId, imageId } = service;
		if (!appId) {
			continue;
		}

		if (apps[appId] == null) {
			apps[appId] = {};
		}
		creationTimesAndReleases[appId] = {};
		if (apps[appId].services == null) {
			apps[appId].services = {};
		}
		// We only send commit if all services have the same release, and it matches the target release
		if (releaseId == null) {
			({ releaseId } = service);
		} else if (releaseId !== service.releaseId) {
			releaseId = false;
		}
		if (imageId == null) {
			throw new InternalInconsistencyError(
				`imageId not defined in ApplicationManager.getStatus: ${service}`,
			);
		}
		if (apps[appId].services[imageId] == null) {
			apps[appId].services[imageId] = _.pick(service, ['status', 'releaseId']);
			creationTimesAndReleases[appId][imageId] = _.pick(service, [
				'createdAt',
				'releaseId',
			]);
			apps[appId].services[imageId].download_progress = null;
		} else {
			// There's two containers with the same imageId, so this has to be a handover
			apps[appId].services[imageId].releaseId = _.minBy(
				[creationTimesAndReleases[appId][imageId], service],
				'createdAt',
			).releaseId;
			apps[appId].services[imageId].status = 'Handing over';
		}
	}

	for (const image of images) {
		const { appId } = image;

		if (!image.dependent) {
			if (apps[appId] == null) {
				apps[appId] = {};
			}
			if (apps[appId].services == null) {
				apps[appId].services = {};
			}
			if (apps[appId].services[image.imageId] == null) {
				apps[appId].services[image.imageId] = _.pick(image, [
					'status',
					'releaseId',
				]);
				apps[appId].services[image.imageId].download_progress =
					image.downloadProgress;
			}
		} else if (image.imageId != null) {
			if (dependent[appId] == null) {
				dependent[appId] = {};
			}
			if (dependent[appId].images == null) {
				dependent[appId].images = {};
			}
			dependent[appId].images[image.imageId] = _.pick(image, ['status']);
			dependent[appId].images[image.imageId].download_progress =
				image.downloadProgress;
		} else {
			log.debug('Ignoring legacy dependent image', image);
		}
	}

	return { local: apps, dependent };
}
