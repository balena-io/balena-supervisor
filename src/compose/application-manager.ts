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
	TargetState,
} from '../types/state';
import { checkTruthy, checkInt } from '../lib/validation';
import { Proxyvisor } from '../proxyvisor';
import * as updateLock from '../lib/update-lock';
import { EventEmitter } from 'events';

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
	await imageManager.normaliseImageData();
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
	const [downloading, availableImages, currentApps] = await Promise.all([
		imageManager.getDownloadingImageIds(),
		imageManager.getAvailable(),
		getCurrentApps(),
	]);
	const containerIdsByAppId = await getAppContainerIds(currentApps);

	return await inferNextSteps(currentApps, targetApps, {
		ignoreImages,
		downloading,
		availableImages,
		containerIdsByAppId,
	});
}

// Calculate the required steps from the current to the target state
export async function inferNextSteps(
	currentApps: InstancedAppState,
	targetApps: InstancedAppState,
	{
		ignoreImages = false,
		downloading = [] as number[],
		availableImages = [] as Image[],
		containerIdsByAppId = {} as { [appId: number]: Dictionary<string> },
	} = {},
) {
	// get some required data
	const [{ localMode, delta }, cleanupNeeded] = await Promise.all([
		config.getMany(['localMode', 'delta']),
		imageManager.isCleanupNeeded(),
	]);

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
				const { appId } = targetApps[id];
				const emptyCurrent = new App(
					{
						appId,
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

export async function getCurrentApps(): Promise<InstancedAppState> {
	const volumes = _.groupBy(await volumeManager.getAll(), 'appId');
	const networks = _.groupBy(await networkManager.getAll(), 'appId');
	const services = _.groupBy(await serviceManager.getAll(), 'appId');

	const allAppIds = _.union(
		Object.keys(volumes),
		Object.keys(networks),
		Object.keys(services),
	).map((i) => parseInt(i, 10));

	const apps: InstancedAppState = {};
	for (const appId of allAppIds) {
		const commit = await commitStore.getCommitForApp(appId);
		apps[appId] = new App(
			{
				appId,
				services: services[appId] ?? [],
				networks: _.keyBy(networks[appId], 'name'),
				volumes: _.keyBy(volumes[appId], 'name'),
				commit,
			},
			false,
		);
	}

	return apps;
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

// TODO: deprecate this method. Application changes should use intermediate targets
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
	dependent: TargetState['dependent'],
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
				_.map(apps, (_v, appId) => checkInt(appId)),
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
	} else {
		// This only makes sense for dependent devices which are still
		// single app.
		for (const availableImage of available) {
			if (availableImage.appId === image.appId) {
				return availableImage.name;
			}
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
			.map((svc) => [svc.imageName, svc.dockerImageId])
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
		availableWithoutIds,
		(image) =>
			!_.some(currentImages.concat(targetImages), (imageInUse) => {
				return _.isEqual(image, _.omit(imageInUse, ['dockerImageId', 'id']));
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
				// There is an image with same image name or digest
				// on the database
				if (imageManager.isSameImage(availableImage, targetImage)) {
					return true;
				}
				// The database image doesn't have the same name but has
				// the same docker id as the target image
				if (
					availableImage.dockerImageId ===
					targetImageDockerIds[targetImage.name]
				) {
					return true;
				}
				return false;
			});

			// There is no image in the database with the same metadata
			const isNotSaved = !_.some(availableWithoutIds, (img) =>
				_.isEqual(img, targetImage),
			);

			// The image is not on the database but we know it exists on the
			// engine because we could find it through inspectByName
			const isAvailableOnTheEngine = !!targetImageDockerIds[targetImage.name];

			return (
				(isActuallyAvailable && isNotSaved) ||
				(!isActuallyAvailable && isAvailableOnTheEngine)
			);
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
