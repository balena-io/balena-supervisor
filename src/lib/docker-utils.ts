import { DockerProgress, ProgressCallback } from 'docker-progress';
import * as Dockerode from 'dockerode';
import * as _ from 'lodash';
import * as memoizee from 'memoizee';

import { applyDelta, OutOfSyncError } from 'docker-delta';
import DockerToolbelt = require('docker-toolbelt');

import { SchemaReturn } from '../config/schema-type';
import { envArrayToObject } from './conversions';
import {
	DeltaStillProcessingError,
	ImageAuthenticationError,
	InvalidNetGatewayError,
} from './errors';
import * as request from './request';
import { EnvVarObject } from './types';

import log from './supervisor-console';

export type FetchOptions = SchemaReturn<'fetchOptions'>;
export type DeltaFetchOptions = FetchOptions & {
	deltaSourceId: string;
	deltaSource: string;
};

interface RsyncApplyOptions {
	timeout: number;
	maxRetries: number;
	retryInterval: number;
}

type ImageNameParts = {
	registry?: string;
	imageName: string;
	tagName?: string;
	digest?: string;
};

// How long do we keep a delta token before invalidating it
// (10 mins)
const DELTA_TOKEN_TIMEOUT = 10 * 60 * 1000;

export const docker = new Dockerode();
export const dockerToolbelt = new DockerToolbelt(undefined);
export const dockerProgress = new DockerProgress({
	dockerToolbelt,
});

// Separate string containing registry and image name into its parts.
// Example: registry2.balena.io/balena/rpi
//          { registry: "registry2.balena.io", imageName: "balena/rpi" }
// Moved here from
// https://github.com/balena-io-modules/docker-toolbelt/blob/master/lib/docker-toolbelt.coffee#L338
export function getRegistryAndName(uri: string): ImageNameParts {
	// https://github.com/docker/distribution/blob/release/2.7/reference/normalize.go#L62
	// https://github.com/docker/distribution/blob/release/2.7/reference/regexp.go#L44
	const match = uri.match(
		/^(?:(localhost|.*?[.:].*?)\/)?(.+?)(?::(.*?))?(?:@(.*?))?$/,
	);

	if (!match) {
		throw new Error(`Could not parse the image: ${uri}`);
	}

	const [, registry, imageName, tag, digest] = match;
	const tagName = !digest && !tag ? 'latest' : tag;
	const digestMatch = digest?.match(
		/^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-f-A-F]{32,}$/,
	);
	if (!imageName || (digest && !digestMatch)) {
		throw new Error(
			'Invalid image name, expected [domain.tld/]repo/image[:tag][@digest] format',
		);
	}

	return { registry, imageName, tagName, digest };
}

// Normalise an image name to always have a tag, with :latest being the default
export function normaliseImageName(image: string) {
	const { registry, imageName, tagName, digest } = getRegistryAndName(image);
	const repository = [registry, imageName].join('/');

	if (!digest) {
		return [repository, tagName || 'latest'].join(':');
	}

	// Intentionally discard the tag when a digest exists
	return [repository, digest].join('@');
}

export function getRepoAndTag(image: string): { repo: string; tag?: string } {
	const { registry, imageName, tagName } = getRegistryAndName(image);

	let repoName = imageName;

	if (registry != null) {
		repoName = `${registry}/${imageName}`;
	}

	return { repo: repoName, tag: tagName };
}

// Same as getRepoAndTag but joined with ':' for searching
export function getImageWithTag(image: string) {
	const { repo, tag } = getRepoAndTag(image);
	return [repo, tag || 'latest'].join(':');
}

export async function fetchDeltaWithProgress(
	imgDest: string,
	deltaOpts: DeltaFetchOptions,
	onProgress: ProgressCallback,
	serviceName: string,
): Promise<string> {
	const deltaSourceId =
		deltaOpts.deltaSourceId != null
			? deltaOpts.deltaSourceId
			: deltaOpts.deltaSource;

	const timeout = deltaOpts.deltaApplyTimeout;

	const logFn = (str: string) =>
		log.debug(`delta([${serviceName}] ${deltaOpts.deltaSource}): ${str}`);

	if (!_.includes([2, 3], deltaOpts.deltaVersion)) {
		logFn(
			`Unsupported delta version: ${deltaOpts.deltaVersion}. Falling back to regular pull`,
		);
		return await fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	// We need to make sure that we're not trying to apply a
	// v3 delta on top of a v2 delta, as this will cause the
	// update to fail, and we must fall back to a standard
	// image pull
	if (
		deltaOpts.deltaVersion === 3 &&
		(await isV2DeltaImage(deltaOpts.deltaSourceId))
	) {
		logFn(`Cannot create a delta from V2 to V3, falling back to regular pull`);
		return await fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	// Since the supevisor never calls this function with a source anymore,
	// this should never happen, but w ehandle it anyway
	if (deltaOpts.deltaSource == null) {
		logFn('Falling back to regular pull due to lack of a delta source');
		return fetchImageWithProgress(imgDest, deltaOpts, onProgress);
	}

	logFn(`Starting delta to ${imgDest}`);

	const [dstInfo, srcInfo] = await Promise.all([
		dockerToolbelt.getRegistryAndName(imgDest),
		dockerToolbelt.getRegistryAndName(deltaOpts.deltaSource),
	]);

	const token = await getAuthToken(srcInfo, dstInfo, deltaOpts);

	const opts: request.requestLib.CoreOptions = {
		followRedirect: false,
		timeout: deltaOpts.deltaRequestTimeout,
		auth: {
			bearer: token,
			sendImmediately: true,
		},
	};

	const url = `${deltaOpts.deltaEndpoint}/api/v${deltaOpts.deltaVersion}/delta?src=${deltaOpts.deltaSource}&dest=${imgDest}`;

	const [res, data] = await (await request.getRequestInstance()).getAsync(
		url,
		opts,
	);
	if (res.statusCode === 502 || res.statusCode === 504) {
		throw new DeltaStillProcessingError();
	}
	let id: string;
	try {
		switch (deltaOpts.deltaVersion) {
			case 2:
				if (
					!(
						res.statusCode >= 300 &&
						res.statusCode < 400 &&
						res.headers['location'] != null
					)
				) {
					throw new Error(
						`Got ${res.statusCode} when requesting an image from delta server.`,
					);
				}
				const deltaUrl = res.headers['location'];
				const deltaSrc = deltaSourceId;
				const resumeOpts = {
					timeout: deltaOpts.deltaRequestTimeout,
					maxRetries: deltaOpts.deltaRetryCount,
					retryInterval: deltaOpts.deltaRetryInterval,
				};
				id = await applyRsyncDelta(
					deltaSrc,
					deltaUrl,
					timeout,
					resumeOpts,
					onProgress,
					logFn,
				);
				break;
			case 3:
				if (res.statusCode !== 200) {
					throw new Error(
						`Got ${res.statusCode} when requesting v3 delta from delta server.`,
					);
				}
				let name;
				try {
					name = JSON.parse(data).name;
				} catch (e) {
					throw new Error(
						`Got an error when parsing delta server response for v3 delta: ${e}`,
					);
				}
				id = await applyBalenaDelta(name, token, onProgress, logFn);
				break;
			default:
				throw new Error(`Unsupported delta version: ${deltaOpts.deltaVersion}`);
		}
	} catch (e) {
		if (e instanceof OutOfSyncError) {
			logFn('Falling back to regular pull due to delta out of sync error');
			return await fetchImageWithProgress(imgDest, deltaOpts, onProgress);
		} else {
			logFn(`Delta failed with ${e}`);
			throw e;
		}
	}

	logFn(`Delta applied successfully`);
	return id;
}

export async function fetchImageWithProgress(
	image: string,
	{ uuid, currentApiKey }: FetchOptions,
	onProgress: ProgressCallback,
): Promise<string> {
	const { registry } = await dockerToolbelt.getRegistryAndName(image);

	const dockerOpts = {
		authconfig: {
			username: `d_${uuid}`,
			password: currentApiKey,
			serverAddress: registry,
		},
	};

	await dockerProgress.pull(image, onProgress, dockerOpts);
	return (await docker.getImage(image).inspect()).Id;
}

export async function getImageEnv(id: string): Promise<EnvVarObject> {
	const inspect = await docker.getImage(id).inspect();

	try {
		return envArrayToObject(_.get(inspect, ['Config', 'Env'], []));
	} catch (e) {
		log.error('Error getting env from image', e);
		return {};
	}
}

export async function getNetworkGateway(networkName: string): Promise<string> {
	if (networkName === 'host') {
		return '127.0.0.1';
	}

	const network = await docker.getNetwork(networkName).inspect();
	const config = _.get(network, ['IPAM', 'Config', '0']);
	if (config != null) {
		if (config.Gateway != null) {
			return config.Gateway;
		}
		if (config.Subnet != null && _.endsWith(config.Subnet, '.0/16')) {
			return config.Subnet.replace('.0/16', '.1');
		}
	}
	throw new InvalidNetGatewayError(
		`Cannot determine network gateway for ${networkName}`,
	);
}

function applyRsyncDelta(
	imgSrc: string,
	deltaUrl: string,
	applyTimeout: number,
	opts: RsyncApplyOptions,
	onProgress: ProgressCallback,
	logFn: (str: string) => void,
): Promise<string> {
	logFn('Applying rsync delta...');

	return new Promise(async (resolve, reject) => {
		const resumable = await request.getResumableRequest();
		const req = resumable(Object.assign({ url: deltaUrl }, opts));
		req
			.on('progress', onProgress)
			.on('retry', onProgress)
			.on('error', reject)
			.on('response', (res) => {
				if (res.statusCode !== 200) {
					reject(
						new Error(
							`Got ${res.statusCode} when requesting delta from storage.`,
						),
					);
				} else if (parseInt(res.headers['content-length'] || '0', 10) === 0) {
					reject(new Error('Invalid delta URL'));
				} else {
					const deltaStream = applyDelta(imgSrc, {
						log: logFn,
						timeout: applyTimeout,
					});
					res
						.pipe(deltaStream)
						.on('id', (id) => resolve(`sha256:${id}`))
						.on('error', (err) => {
							logFn(`Delta stream emitted error: ${err}`);
							req.abort();
							reject(err);
						});
				}
			});
	});
}

async function applyBalenaDelta(
	deltaImg: string,
	token: string | null,
	onProgress: ProgressCallback,
	logFn: (str: string) => void,
): Promise<string> {
	logFn('Applying balena delta...');

	let auth: Dictionary<unknown> | undefined;
	if (token != null) {
		logFn('Using registry auth token');
		auth = {
			authconfig: {
				registrytoken: token,
			},
		};
	}

	await dockerProgress.pull(deltaImg, onProgress, auth);
	return (await docker.getImage(deltaImg).inspect()).Id;
}

export async function isV2DeltaImage(imageName: string): Promise<boolean> {
	const inspect = await docker.getImage(imageName).inspect();

	// It's extremely unlikely that an image is valid if
	// it's smaller than 40 bytes, but a v2 delta always is.
	// For this reason, this is the method that we use to
	// detect when an image is a v2 delta
	return inspect.Size < 40 && inspect.VirtualSize < 40;
}

const getAuthToken = memoizee(
	async (
		srcInfo: ImageNameParts,
		dstInfo: ImageNameParts,
		deltaOpts: DeltaFetchOptions,
	): Promise<string> => {
		const tokenEndpoint = `${deltaOpts.apiEndpoint}/auth/v1/token`;
		const tokenOpts: request.requestLib.CoreOptions = {
			auth: {
				user: `d_${deltaOpts.uuid}`,
				pass: deltaOpts.currentApiKey,
				sendImmediately: true,
			},
			json: true,
		};
		const tokenUrl = `${tokenEndpoint}?service=${dstInfo.registry}&scope=repository:${dstInfo.imageName}:pull&scope=repository:${srcInfo.imageName}:pull`;

		const tokenResponseBody = (
			await (await request.getRequestInstance()).getAsync(tokenUrl, tokenOpts)
		)[1];
		const token = tokenResponseBody != null ? tokenResponseBody.token : null;

		if (token == null) {
			throw new ImageAuthenticationError('Authentication error');
		}

		return token;
	},
	{ maxAge: DELTA_TOKEN_TIMEOUT, promise: true },
);
