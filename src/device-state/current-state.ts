import Bluebird = require('bluebird');
import * as _ from 'lodash';
import * as url from 'url';
import { CoreOptions } from 'request';

import * as constants from '../lib/constants';
import { log } from '../lib/supervisor-console';
import { InternalInconsistencyError, StatusError } from '../lib/errors';
import { getRequestInstance } from '../lib/request';
import * as sysInfo from '../lib/system-info';

import { DeviceStatus } from '../types/state';
import * as config from '../config';
import { SchemaTypeKey, SchemaReturn } from '../config/schema-type';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import { downloadProgress } from '../lib/download-progress';

// The exponential backoff starts at 15s
const MINIMUM_BACKOFF_DELAY = 15000;

const INTERNAL_STATE_KEYS = [
	'update_pending',
	'update_downloaded',
	'update_failed',
];

export let stateReportErrors = 0;
const lastReportedState: DeviceStatus = {
	local: {},
	dependent: {},
};
const stateForReport: DeviceStatus = {
	local: {},
	dependent: {},
};
let reportPending = false;

type CurrentStateReportConf = {
	[key in keyof Pick<
		config.ConfigMap<SchemaTypeKey>,
		| 'uuid'
		| 'apiEndpoint'
		| 'apiTimeout'
		| 'deviceApiKey'
		| 'deviceId'
		| 'localMode'
		| 'hardwareMetrics'
	>]: SchemaReturn<key>;
};

/**
 * Returns an object that contains only status fields relevant for the local mode.
 * It basically removes information about applications state.
 */
const stripDeviceStateInLocalMode = (state: DeviceStatus): DeviceStatus => {
	return {
		local: _.cloneDeep(
			_.omit(state.local, 'apps', 'is_on__commit', 'logs_channel'),
		),
	};
};

const sendReportPatch = async (
	stateDiff: DeviceStatus,
	conf: Omit<CurrentStateReportConf, 'deviceId' | 'hardwareMetrics'>,
) => {
	let body = stateDiff;
	const { apiEndpoint, apiTimeout, deviceApiKey, localMode, uuid } = conf;
	if (localMode) {
		body = stripDeviceStateInLocalMode(stateDiff);
		// In local mode, check if it still makes sense to send any updates after data strip.
		if (_.isEmpty(body.local)) {
			// Nothing to send.
			return;
		}
	}

	const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
	const request = await getRequestInstance();

	const params: CoreOptions = {
		json: true,
		headers: {
			Authorization: `Bearer ${deviceApiKey}`,
		},
		body,
	};

	const [{ statusCode, body: statusMessage }] = await request
		.patchAsync(endpoint, params)
		.timeout(apiTimeout);

	if (statusCode < 200 || statusCode >= 300) {
		log.error(`Error from the API: ${statusCode}`);
		throw new StatusError(statusCode, JSON.stringify(statusMessage, null, 2));
	}
};

const getStateDiff = (): DeviceStatus => {
	const lastReportedLocal = lastReportedState.local;
	const lastReportedDependent = lastReportedState.dependent;
	if (lastReportedLocal == null || lastReportedDependent == null) {
		throw new InternalInconsistencyError(
			`No local or dependent component of lastReportedLocal in CurrentState.getStateDiff: ${JSON.stringify(
				lastReportedState,
			)}`,
		);
	}

	const diff = {
		local: _.omitBy(
			stateForReport.local,
			(val, key: keyof NonNullable<DeviceStatus['local']>) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(lastReportedLocal[key], val) ||
				!sysInfo.isSignificantChange(
					key,
					lastReportedLocal[key] as number,
					val as number,
				),
		),
		dependent: _.omitBy(
			stateForReport.dependent,
			(val, key: keyof DeviceStatus['dependent']) =>
				INTERNAL_STATE_KEYS.includes(key) ||
				_.isEqual(lastReportedDependent[key], val),
		),
	};

	return _.omitBy(diff, _.isEmpty);
};

const report = _.throttle(async () => {
	const conf = await config.getMany([
		'deviceApiKey',
		'apiTimeout',
		'apiEndpoint',
		'uuid',
		'localMode',
	]);

	const stateDiff = getStateDiff();
	if (_.size(stateDiff) === 0) {
		return 0;
	}

	if (conf.uuid == null || conf.apiEndpoint == null) {
		throw new InternalInconsistencyError(
			'No uuid or apiEndpoint provided to CurrentState.report',
		);
	}

	try {
		await sendReportPatch(stateDiff, conf);

		stateReportErrors = 0;
		_.assign(lastReportedState.local, stateDiff.local);
		_.assign(lastReportedState.dependent, stateDiff.dependent);
	} catch (e) {
		if (e instanceof StatusError) {
			// We don't want this to be classed as a report error, as this will cause
			// the watchdog to kill the supervisor - and killing the supervisor will
			// not help in this situation
			log.error(
				`Non-200 response from the API! Status code: ${e.statusCode} - message:`,
				e,
			);
		} else {
			throw e;
		}
	}
}, constants.maxReportFrequency);

const reportCurrentState = (): null => {
	(async () => {
		reportPending = true;
		try {
			const currentDeviceState = await deviceState.getStatus();
			// If hardwareMetrics is false, send null patch for system metrics to cloud API
			const info = {
				...((await config.get('hardwareMetrics'))
					? await sysInfo.getSystemMetrics()
					: {
							cpu_usage: null,
							memory_usage: null,
							memory_total: null,
							storage_usage: null,
							storage_total: null,
							storage_block_device: null,
							cpu_temp: null,
							cpu_id: null,
					  }),
				...(await sysInfo.getSystemChecks()),
			};

			stateForReport.local = {
				...stateForReport.local,
				...currentDeviceState.local,
				...info,
			};
			stateForReport.dependent = {
				...stateForReport.dependent,
				...currentDeviceState.dependent,
			};

			// Report current state
			await report();
			// Finishing pending report
			reportPending = false;
		} catch (e) {
			eventTracker.track('Device state report failure', { error: e });
			// We use the poll interval as the upper limit of
			// the exponential backoff
			const maxDelay = await config.get('appUpdatePollInterval');
			const delay = Math.min(
				2 ** stateReportErrors * MINIMUM_BACKOFF_DELAY,
				maxDelay,
			);

			++stateReportErrors;
			await Bluebird.delay(delay);
			reportCurrentState();
		}
	})();
	return null;
};

export const startReporting = () => {
	const doReport = () => {
		if (!reportPending) {
			reportCurrentState();
		}
	};

	// If the state changes, report it
	deviceState.on('change', doReport);
	deviceState.on('change', downloadProgress);
	// But check once every max report frequency to ensure that changes in system
	// info are picked up (CPU temp etc)
	setInterval(doReport, constants.maxReportFrequency);
	// Try to perform a report right away
	return doReport();
};
