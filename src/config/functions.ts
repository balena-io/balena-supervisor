import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as memoizee from 'memoizee';
import { fs } from 'mz';
import { URL } from 'url';

import supervisorVersion from '../lib/supervisor-version';

import * as config from '.';
import * as constants from '../lib/constants';
import * as osRelease from '../lib/os-release';
import * as macAddress from '../lib/mac-address';
import log from '../lib/supervisor-console';

export const fnSchema = {
	version: () => {
		return Bluebird.resolve(supervisorVersion);
	},
	currentApiKey: () => {
		return config
			.getMany(['apiKey', 'deviceApiKey'])
			.then(({ apiKey, deviceApiKey }) => {
				return apiKey || deviceApiKey;
			});
	},
	provisioned: () => {
		return config
			.getMany(['uuid', 'apiEndpoint', 'registered_at', 'deviceId'])
			.then((requiredValues) => {
				return _.every(_.values(requiredValues));
			});
	},
	osVersion: () => {
		return osRelease.getOSVersion(constants.hostOSVersionPath);
	},
	osVariant: () => {
		return osRelease.getOSVariant(constants.hostOSVersionPath);
	},
	macAddress: () => {
		return macAddress.getAll(constants.macAddressPath);
	},
	deviceArch: memoizee(
		async () => {
			try {
				// FIXME: We should be mounting the following file into the supervisor from the
				// start-resin-supervisor script, changed in meta-resin - but until then, hardcode it
				const data = await fs.readFile(
					`${constants.rootMountPoint}${constants.bootMountPoint}/device-type.json`,
					'utf8',
				);
				const deviceInfo = JSON.parse(data);

				return deviceInfo.arch;
			} catch (e) {
				log.error(`Unable to get architecture: ${e}`);
				throw e;
			}
		},
		{ promise: true },
	),
	deviceType: memoizee(
		async () => {
			try {
				// FIXME: We should be mounting the following file into the supervisor from the
				// start-resin-supervisor script, changed in meta-resin - but until then, hardcode it
				const data = await fs.readFile(
					`${constants.rootMountPoint}${constants.bootMountPoint}/device-type.json`,
					'utf8',
				);
				const deviceInfo = JSON.parse(data);

				return deviceInfo.slug;
			} catch (e) {
				log.error(`Unable to get device type: ${e}`);
				throw e;
			}
		},
		{ promise: true },
	),
	provisioningOptions: () => {
		return config
			.getMany([
				'uuid',
				'applicationId',
				'apiKey',
				'deviceApiKey',
				'deviceArch',
				'deviceType',
				'apiEndpoint',
				'apiTimeout',
				'registered_at',
				'deviceId',
			])
			.then((conf) => {
				return {
					uuid: conf.uuid,
					applicationId: conf.applicationId,
					deviceArch: conf.deviceArch,
					deviceType: conf.deviceType,
					provisioningApiKey: conf.apiKey,
					deviceApiKey: conf.deviceApiKey,
					apiEndpoint: conf.apiEndpoint,
					apiTimeout: conf.apiTimeout,
					registered_at: conf.registered_at,
					deviceId: conf.deviceId,
				};
			});
	},
	mixpanelHost: () => {
		return config.get('apiEndpoint').then((apiEndpoint) => {
			if (!apiEndpoint) {
				return null;
			}
			const url = new URL(apiEndpoint);
			return { host: url.host, path: '/mixpanel' };
		});
	},
	extendedEnvOptions: () => {
		return config.getMany([
			'uuid',
			'listenPort',
			'name',
			'apiEndpoint',
			'deviceApiKey',
			'version',
			'deviceArch',
			'deviceType',
			'osVersion',
		]);
	},
	fetchOptions: () => {
		return config.getMany([
			'uuid',
			'currentApiKey',
			'apiEndpoint',
			'deltaEndpoint',
			'delta',
			'deltaRequestTimeout',
			'deltaApplyTimeout',
			'deltaRetryCount',
			'deltaRetryInterval',
			'deltaVersion',
		]);
	},
	unmanaged: () => {
		return config.get('apiEndpoint').then((apiEndpoint) => {
			return !apiEndpoint;
		});
	},
};

export type FnSchema = typeof fnSchema;
export type FnSchemaKey = keyof FnSchema;
