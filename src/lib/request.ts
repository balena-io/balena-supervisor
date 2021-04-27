import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as requestLib from 'request';
import * as resumableRequestLib from 'resumable-request';

import * as constants from './constants';
import * as osRelease from './os-release';

import supervisorVersion from './supervisor-version';

export { requestLib };

// With these settings, the device must be unable to receive a single byte
// from the network for a continuous period of 20 minutes before we give up.
// (reqTimeout + retryInterval) * retryCount / 1000ms / 60sec ~> minutes
const DEFAULT_REQUEST_TIMEOUT = 30000; // ms
const DEFAULT_REQUEST_RETRY_INTERVAL = 10000; // ms
const DEFAULT_REQUEST_RETRY_COUNT = 30;

type PromisifiedRequest = typeof requestLib & {
	delAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	putAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	postAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	patchAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
	getAsync: (
		uri: string | requestLib.CoreOptions,
		options?: requestLib.CoreOptions | undefined,
	) => Bluebird<[requestLib.Response, any]>;
};

const getRequestInstances = _.once(async () => {
	// Generate the user agents with out versions
	const osVersion = await osRelease.getOSVersion(constants.hostOSVersionPath);
	const osVariant = await osRelease.getOSVariant(constants.hostOSVersionPath);
	let userAgent = `Supervisor/${supervisorVersion}`;
	if (osVersion != null) {
		if (osVariant != null) {
			userAgent += ` (Linux; ${osVersion}; ${osVariant})`;
		} else {
			userAgent += ` (Linux; ${osVersion})`;
		}
	}

	const requestOpts: requestLib.CoreOptions = {
		gzip: true,
		timeout: DEFAULT_REQUEST_TIMEOUT,
		headers: {
			'User-Agent': userAgent,
		},
	};

	const resumableOpts = {
		timeout: DEFAULT_REQUEST_TIMEOUT,
		maxRetries: DEFAULT_REQUEST_RETRY_COUNT,
		retryInterval: DEFAULT_REQUEST_RETRY_INTERVAL,
	};

	const requestHandle = requestLib.defaults(requestOpts);

	const request = Bluebird.promisifyAll(requestHandle, {
		multiArgs: true,
	}) as PromisifiedRequest;
	const resumable = resumableRequestLib.defaults(resumableOpts);

	return {
		requestOpts,
		request,
		resumable,
	};
});

export const getRequestInstance = _.once(async () => {
	return (await getRequestInstances()).request;
});

export const getRequestOptions = _.once(async () => {
	return (await getRequestInstances()).requestOpts;
});

export const getResumableRequest = _.once(async () => {
	return (await getRequestInstances()).resumable;
});
