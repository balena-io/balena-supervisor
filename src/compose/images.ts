import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

import * as config from '../config';
import * as db from '../db';
import * as constants from '../lib/constants';
import { DeltaFetchOptions, FetchOptions, docker } from '../lib/docker-utils';
import * as dockerUtils from '../lib/docker-utils';
import { DeltaStillProcessingError, NotFoundError } from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import * as validation from '../lib/validation';
import * as logger from '../logger';
import { ImageDownloadBackoffError } from './errors';

import type { Service } from './service';

import log from '../lib/supervisor-console';

interface FetchProgressEvent {
	percentage: number;
}

export interface Image {
	id?: number;
	// image registry/repo@digest or registry/repo:tag
	name: string;
	appId: number;
	serviceId: number;
	serviceName: string;
	// Id from balena api
	imageId: number;
	releaseId: number;
	dependent: number;
	dockerImageId?: string;
	status?: 'Downloading' | 'Downloaded' | 'Deleting';
	downloadProgress?: number | null;
}

// Setup an event emitter
interface ImageEvents {
	change: void;
}
class ImageEventEmitter extends (EventEmitter as new () => StrictEventEmitter<
	EventEmitter,
	ImageEvents
>) {}
const events = new ImageEventEmitter();

export const on: typeof events['on'] = events.on.bind(events);
export const once: typeof events['once'] = events.once.bind(events);
export const removeListener: typeof events['removeListener'] = events.removeListener.bind(
	events,
);
export const removeAllListeners: typeof events['removeAllListeners'] = events.removeAllListeners.bind(
	events,
);

const imageFetchFailures: Dictionary<number> = {};
const imageFetchLastFailureTime: Dictionary<ReturnType<
	typeof process.hrtime
>> = {};
const imageCleanupFailures: Dictionary<number> = {};
// A store of volatile state for images (e.g. download progress), indexed by imageId
const volatileState: { [imageId: number]: Image } = {};

let appUpdatePollInterval: number;

export const initialized = (async () => {
	await config.initialized;
	appUpdatePollInterval = await config.get('appUpdatePollInterval');
	config.on('change', (vals) => {
		if (vals.appUpdatePollInterval != null) {
			appUpdatePollInterval = vals.appUpdatePollInterval;
		}
	});
})();

type ServiceInfo = Pick<
	Service,
	'imageName' | 'appId' | 'serviceId' | 'serviceName' | 'imageId' | 'releaseId'
>;
export function imageFromService(service: ServiceInfo): Image {
	// We know these fields are defined because we create these images from target state
	return {
		name: service.imageName!,
		appId: service.appId,
		serviceId: service.serviceId!,
		serviceName: service.serviceName!,
		imageId: service.imageId!,
		releaseId: service.releaseId!,
		dependent: 0,
	};
}

export async function triggerFetch(
	image: Image,
	opts: FetchOptions,
	onFinish = _.noop,
	serviceName: string,
): Promise<void> {
	if (imageFetchFailures[image.name] != null) {
		// If we are retrying a pull within the backoff time of the last failure,
		// we need to throw an error, which will be caught in the device-state
		// engine, and ensure that we wait a bit lnger
		const minDelay = Math.min(
			2 ** imageFetchFailures[image.name] * constants.backoffIncrement,
			appUpdatePollInterval,
		);
		const timeSinceLastError = process.hrtime(
			imageFetchLastFailureTime[image.name],
		);
		const timeSinceLastErrorMs =
			timeSinceLastError[0] * 1000 + timeSinceLastError[1] / 1e6;
		if (timeSinceLastErrorMs < minDelay) {
			throw new ImageDownloadBackoffError();
		}
	}

	const onProgress = (progress: FetchProgressEvent) => {
		// Only report the percentage if we haven't finished fetching
		if (volatileState[image.imageId] != null) {
			reportChange(image.imageId, {
				downloadProgress: progress.percentage,
			});
		}
	};

	let success: boolean;
	try {
		const imageName = normalise(image.name);
		image = _.clone(image);
		image.name = imageName;

		await markAsSupervised(image);

		const img = await inspectByName(image.name);
		await db.models('image').update({ dockerImageId: img.Id }).where(image);

		onFinish(true);
		return;
	} catch (e) {
		if (!NotFoundError(e)) {
			if (!(e instanceof ImageDownloadBackoffError)) {
				addImageFailure(image.name);
			}
			throw e;
		}
		reportChange(
			image.imageId,
			_.merge(_.clone(image), { status: 'Downloading', downloadProgress: 0 }),
		);

		try {
			let id;
			if (opts.delta && (opts as DeltaFetchOptions).deltaSource != null) {
				id = await fetchDelta(image, opts, onProgress, serviceName);
			} else {
				id = await fetchImage(image, opts, onProgress);
			}

			await db.models('image').update({ dockerImageId: id }).where(image);

			logger.logSystemEvent(LogTypes.downloadImageSuccess, { image });
			success = true;
			delete imageFetchFailures[image.name];
			delete imageFetchLastFailureTime[image.name];
		} catch (err) {
			if (err instanceof DeltaStillProcessingError) {
				// If this is a delta image pull, and the delta still hasn't finished generating,
				// don't show a failure message, and instead just inform the user that it's remotely
				// processing
				logger.logSystemEvent(LogTypes.deltaStillProcessingError, {});
			} else {
				addImageFailure(image.name);
				logger.logSystemEvent(LogTypes.downloadImageError, {
					image,
					error: err,
				});
			}
			success = false;
		}
	}

	reportChange(image.imageId);
	onFinish(success);
}

export async function remove(image: Image): Promise<void> {
	try {
		await removeImageIfNotNeeded(image);
	} catch (e) {
		logger.logSystemEvent(LogTypes.deleteImageError, {
			image,
			error: e,
		});
		throw e;
	}
}

export function getByDockerId(id: string): Promise<Image> {
	return db.models('image').where({ dockerImageId: id }).first();
}

export async function removeByDockerId(id: string): Promise<void> {
	const image = await getByDockerId(id);
	await remove(image);
}

export function getNormalisedTags(image: Docker.ImageInfo): string[] {
	return (image.RepoTags || []).map(normalise);
}

async function withImagesFromDockerAndDB<T>(
	cb: (dockerImages: Docker.ImageInfo[], composeImages: Image[]) => T,
) {
	const [normalisedImages, dbImages] = await Promise.all([
		Bluebird.map(docker.listImages({ digests: true }), (image) => ({
			...image,
			RepoTag: getNormalisedTags(image),
		})),
		db.models('image').select(),
	]);
	return cb(normalisedImages, dbImages);
}

function addImageFailure(imageName: string, time = process.hrtime()) {
	imageFetchLastFailureTime[imageName] = time;
	imageFetchFailures[imageName] =
		imageFetchFailures[imageName] != null
			? imageFetchFailures[imageName] + 1
			: 1;
}

function matchesTagOrDigest(
	image: Image,
	dockerImage: Docker.ImageInfo,
): boolean {
	return (
		_.includes(dockerImage.RepoTags, image.name) ||
		_.some(dockerImage.RepoDigests, (digest) =>
			hasSameDigest(image.name, digest),
		)
	);
}

function isAvailableInDocker(
	image: Image,
	dockerImages: Docker.ImageInfo[],
): boolean {
	return _.some(
		dockerImages,
		(dockerImage) =>
			matchesTagOrDigest(image, dockerImage) ||
			image.dockerImageId === dockerImage.Id,
	);
}

export async function getAvailable(): Promise<Image[]> {
	return withImagesFromDockerAndDB((dockerImages, supervisedImages) =>
		_.filter(supervisedImages, (image) =>
			isAvailableInDocker(image, dockerImages),
		),
	);
}

export function getDownloadingImageIds(): number[] {
	return _.keys(_.pickBy(volatileState, { status: 'Downloading' })).map((i) =>
		validation.checkInt(i),
	) as number[];
}

export async function cleanupDatabase(): Promise<void> {
	const imagesToRemove = await withImagesFromDockerAndDB(
		async (dockerImages, supervisedImages) => {
			for (const supervisedImage of supervisedImages) {
				// If the supervisor was interrupted between fetching an image and storing its id,
				// some entries in the db might need to have the dockerImageId populated
				if (supervisedImage.dockerImageId == null) {
					const id = _.get(
						_.find(dockerImages, (dockerImage) =>
							matchesTagOrDigest(supervisedImage, dockerImage),
						),
						'Id',
					);

					if (id != null) {
						await db
							.models('image')
							.update({ dockerImageId: id })
							.where(supervisedImage);
						supervisedImage.dockerImageId = id;
					}
				}
			}
			return _.reject(supervisedImages, (image) =>
				isAvailableInDocker(image, dockerImages),
			);
		},
	);

	const ids = _(imagesToRemove).map('id').compact().value();
	await db.models('image').del().whereIn('id', ids);
}

export const getStatus = async () => {
	const images = await getAvailable();
	for (const image of images) {
		image.status = 'Downloaded';
		image.downloadProgress = null;
	}
	const status = _.clone(volatileState);
	for (const image of images) {
		if (status[image.imageId] == null) {
			status[image.imageId] = image;
		}
	}
	return _.values(status);
};

export async function update(image: Image): Promise<void> {
	const formattedImage = format(image);
	await db
		.models('image')
		.update(formattedImage)
		.where({ name: formattedImage.name });
}

export const save = async (image: Image): Promise<void> => {
	const img = await inspectByName(image.name);
	image = _.clone(image);
	image.dockerImageId = img.Id;
	await markAsSupervised(image);
};

async function getImagesForCleanup(): Promise<string[]> {
	const images: string[] = [];

	const supervisorImageInfo = dockerUtils.getRegistryAndName(
		constants.supervisorImage,
	);
	const [supervisorImage, usedImageIds] = await Promise.all([
		docker.getImage(constants.supervisorImage).inspect(),
		db
			.models('image')
			.select('dockerImageId')
			.then((vals) => vals.map((img: Image) => img.dockerImageId)),
	]);

	const supervisorRepos = [supervisorImageInfo.imageName];
	// If we're on the new balena/ARCH-supervisor image
	if (_.startsWith(supervisorImageInfo.imageName, 'balena/')) {
		supervisorRepos.push(
			supervisorImageInfo.imageName.replace(/^balena/, 'resin'),
		);
	}

	const isSupervisorRepoTag = ({
		imageName,
		tagName,
	}: {
		imageName: string;
		tagName?: string;
	}) => {
		return (
			_.some(supervisorRepos, (repo) => imageName === repo) &&
			tagName !== supervisorImageInfo.tagName
		);
	};

	const dockerImages = await docker.listImages({ digests: true });
	for (const image of dockerImages) {
		// Cleanup should remove truly dangling images (i.e dangling and with no digests)
		if (isDangling(image) && !_.includes(usedImageIds, image.Id)) {
			images.push(image.Id);
		} else if (!_.isEmpty(image.RepoTags) && image.Id !== supervisorImage.Id) {
			// We also remove images from the supervisor repository with a different tag
			for (const tag of image.RepoTags) {
				const imageNameComponents = dockerUtils.getRegistryAndName(tag);
				// If
				if (isSupervisorRepoTag(imageNameComponents)) {
					images.push(image.Id);
				}
			}
		}
	}

	return _(images)
		.uniq()
		.filter(
			(image) =>
				imageCleanupFailures[image] == null ||
				Date.now() - imageCleanupFailures[image] >
					constants.imageCleanupErrorIgnoreTimeout,
		)
		.value();
}

export async function inspectByName(
	imageName: string,
): Promise<Docker.ImageInspectInfo> {
	try {
		const image = await docker.getImage(imageName);
		return await image.inspect();
	} catch (e) {
		if (NotFoundError(e)) {
			const digest = imageName.split('@')[1];
			let imagesFromDb: Image[];
			if (digest != null) {
				imagesFromDb = await db
					.models('image')
					.where('name', 'like', `%@${digest}`);
			} else {
				imagesFromDb = await db
					.models('image')
					.where({ name: imageName })
					.select();
			}

			for (const image of imagesFromDb) {
				if (image.dockerImageId != null) {
					return await docker.getImage(image.dockerImageId).inspect();
				}
			}
		}
		throw e;
	}
}

export async function isCleanupNeeded() {
	return !_.isEmpty(await getImagesForCleanup());
}

export async function cleanup() {
	const images = await getImagesForCleanup();
	for (const image of images) {
		log.debug(`Cleaning up ${image}`);
		try {
			await docker.getImage(image).remove({ force: true });
			delete imageCleanupFailures[image];
		} catch (e) {
			logger.logSystemMessage(
				`Error cleaning up ${image}: ${e.message} - will ignore for 1 hour`,
				{ error: e },
				'Image cleanup error',
			);
			imageCleanupFailures[image] = Date.now();
		}
	}
}

export function isSameImage(
	image1: Pick<Image, 'name'>,
	image2: Pick<Image, 'name'>,
): boolean {
	return (
		image1?.name === image2?.name || hasSameDigest(image1?.name, image2?.name)
	);
}

export function normalise(imageName: string) {
	return dockerUtils.normaliseImageName(imageName);
}

function isDangling(image: Docker.ImageInfo): boolean {
	return (
		(_.isEmpty(image.RepoTags) ||
			_.isEqual(image.RepoTags, ['<none>:<none>'])) &&
		(_.isEmpty(image.RepoDigests) ||
			_.isEqual(image.RepoDigests, ['<none>@<none>']))
	);
}

function hasSameDigest(
	name1: Nullable<string>,
	name2: Nullable<string>,
): boolean {
	const hash1 = name1 != null ? name1.split('@')[1] : null;
	const hash2 = name2 != null ? name2.split('@')[1] : null;
	return hash1 != null && hash1 === hash2;
}

async function removeImageIfNotNeeded(image: Image): Promise<void> {
	let removed: boolean;

	// We first fetch the image from the DB to ensure it exists,
	// and get the dockerImageId and any other missing fields
	const images = await db.models('image').select().where(image);

	if (images.length === 0) {
		removed = false;
	}

	const img = images[0];
	try {
		if (img.dockerImageId == null) {
			// Legacy image from before we started using dockerImageId, so we try to remove it
			// by name
			await docker.getImage(img.name).remove({ force: true });
			removed = true;
		} else {
			const imagesFromDb = await db
				.models('image')
				.where({ dockerImageId: img.dockerImageId })
				.select();
			if (
				imagesFromDb.length === 1 &&
				_.isEqual(format(imagesFromDb[0]), format(img))
			) {
				reportChange(
					image.imageId,
					_.merge(_.clone(image), { status: 'Deleting' }),
				);
				logger.logSystemEvent(LogTypes.deleteImage, { image });
				docker.getImage(img.dockerImageId).remove({ force: true });
				removed = true;
			} else if (imagesFromDb.length > 1 && hasDigest(img.name)) {
				const [dockerRepo] = img.name.split('@');
				const dockerImage = await docker.getImage(img.dockerImageId).inspect();
				const matchingTags = dockerImage.RepoTags.filter((tag) => {
					const [tagRepo] = tag.split(':');
					return tagRepo === dockerRepo;
				});

				reportChange(
					image.imageId,
					_.merge(_.clone(image), { status: 'Deleting' }),
				);
				logger.logSystemEvent(LogTypes.deleteImage, { image });

				// Remove tags that match the repo part of the image.name
				await Promise.all(
					matchingTags.map((tag) =>
						docker.getImage(tag).remove({ noprune: true }),
					),
				);

				// Since there are multiple images with same id we need to
				// remove by name
				await Bluebird.delay(Math.random() * 100); // try to prevent race conditions
				await docker.getImage(img.name).remove();

				removed = true;
			} else if (!hasDigest(img.name)) {
				// Image has a regular tag, so we might have to remove unnecessary tags
				const dockerImage = await docker.getImage(img.dockerImageId).inspect();
				const differentTags = _.reject(imagesFromDb, { name: img.name });

				if (
					dockerImage.RepoTags.length > 1 &&
					_.includes(dockerImage.RepoTags, img.name) &&
					_.some(dockerImage.RepoTags, (t) =>
						_.some(differentTags, { name: t }),
					)
				) {
					await docker.getImage(img.name).remove({ noprune: true });
				}
				removed = false;
			} else {
				removed = false;
			}
		}
	} catch (e) {
		if (NotFoundError(e)) {
			removed = false;
		} else {
			throw e;
		}
	} finally {
		reportChange(image.imageId);
	}

	await db.models('image').del().where({ id: img.id });

	if (removed) {
		logger.logSystemEvent(LogTypes.deleteImageSuccess, { image });
	}
}

async function markAsSupervised(image: Image): Promise<void> {
	const formattedImage = format(image);
	await db.upsertModel(
		'image',
		formattedImage,
		// TODO: Upsert to new values only when they already match? This is likely a bug
		// and currently acts like an "insert if not exists"
		formattedImage,
	);
}

function format(image: Image): Partial<Omit<Image, 'id'>> {
	return _(image)
		.defaults({
			serviceId: null,
			serviceName: null,
			imageId: null,
			releaseId: null,
			dependent: 0,
			dockerImageId: null,
		})
		.omit('id')
		.value();
}

async function fetchDelta(
	image: Image,
	opts: FetchOptions,
	onProgress: (evt: FetchProgressEvent) => void,
	serviceName: string,
): Promise<string> {
	logger.logSystemEvent(LogTypes.downloadImageDelta, { image });

	const deltaOpts = (opts as unknown) as DeltaFetchOptions;
	const srcImage = await inspectByName(deltaOpts.deltaSource);

	deltaOpts.deltaSourceId = srcImage.Id;
	const id = await dockerUtils.fetchDeltaWithProgress(
		image.name,
		deltaOpts,
		onProgress,
		serviceName,
	);

	// TODO: not sure if this can happen anymore
	if (!hasDigest(image.name)) {
		const { repo, tag } = dockerUtils.getRepoAndTag(image.name);
		await docker.getImage(id).tag({ repo, tag });
	}

	return id;
}

function fetchImage(
	image: Image,
	opts: FetchOptions,
	onProgress: (evt: FetchProgressEvent) => void,
): Promise<string> {
	logger.logSystemEvent(LogTypes.downloadImage, { image });
	return dockerUtils.fetchImageWithProgress(image.name, opts, onProgress);
}

// TODO: find out if imageId can actually be null
function reportChange(imageId: Nullable<number>, status?: Partial<Image>) {
	if (imageId == null) {
		return;
	}
	if (status != null) {
		if (volatileState[imageId] == null) {
			volatileState[imageId] = { imageId } as Image;
		}
		_.merge(volatileState[imageId], status);
		return events.emit('change');
	} else if (volatileState[imageId] != null) {
		delete volatileState[imageId];
		return events.emit('change');
	}
}

function hasDigest(name: Nullable<string>): boolean {
	if (name == null) {
		return false;
	}
	const parts = name.split('@');
	return parts[1] != null;
}
