import * as Bluebird from 'bluebird';
import * as constants from '../lib/constants';
import log from '../lib/supervisor-console';
import * as _ from 'lodash';
import { InternalInconsistencyError } from '../lib/errors';
import { DeviceStatus } from '../types/state';
import { getRequestInstance } from '../lib/request';
import * as config from '../config';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import { CoreOptions } from 'request';
import * as url from 'url';

import * as sysInfo from '../lib/system-info';

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

class StatusError extends Error {
	constructor(public statusCode: number) {
		super();
	}
}

/**
 * Returns an object that contains only status fields relevant for the local mode.
 * It basically removes information about applications state.
 *
 * Exported for tests
 */
export const stripDeviceStateInLocalMode = (
	state: DeviceStatus,
): DeviceStatus => {
	return {
		local: _.cloneDeep(
			_.omit(state.local, 'apps', 'is_on__commit', 'logs_channel'),
		),
	};
};

const sendReportPatch = async (
	stateDiff: DeviceStatus,
	conf: { apiEndpoint: string; uuid: string; localMode: boolean },
) => {
	let body = stateDiff;
	if (conf.localMode) {
		body = stripDeviceStateInLocalMode(stateDiff);
		// In local mode, check if it still makes sense to send any updates after data strip.
		if (_.isEmpty(body.local)) {
			// Nothing to send.
			return;
		}
	}
	const { uuid, apiEndpoint, apiTimeout, deviceApiKey } = await config.getMany([
		'uuid',
		'apiEndpoint',
		'apiTimeout',
		'deviceApiKey',
	]);

	const endpoint = url.resolve(apiEndpoint, `/device/v2/${uuid}/state`);
	const request = await getRequestInstance();

	const params: CoreOptions = {
		json: true,
		headers: {
			Authorization: `Bearer ${deviceApiKey}`,
		},
		body,
	};

	const [{ statusCode }] = await request
		.patchAsync(endpoint, params)
		.timeout(apiTimeout);

	if (statusCode < 200 || statusCode >= 300) {
		log.error(`Error from the API: ${statusCode}`);
		throw new StatusError(statusCode);
	}
};

const getStateDiff = (): DeviceStatus => {
	const lastReportedLocal = lastReportedState.local;
	const lastReportedDependent = lastReportedState.dependent;
	if (lastReportedLocal == null || lastReportedDependent == null) {
		throw new InternalInconsistencyError(
			`No local or dependent component of lastReportedLocal in ApiBinder.getStateDiff: ${JSON.stringify(
				lastReportedState,
			)}`,
		);
	}

	const diff = {
		local: _(stateForReport.local)
			.omitBy((val, key: keyof DeviceStatus['local']) =>
				_.isEqual(lastReportedLocal[key], val),
			)
			.omit(INTERNAL_STATE_KEYS)
			.value(),
		dependent: _(stateForReport.dependent)
			.omitBy((val, key: keyof DeviceStatus['dependent']) =>
				_.isEqual(lastReportedDependent[key], val),
			)
			.omit(INTERNAL_STATE_KEYS)
			.value(),
	};

	const toOmit: string[] = sysInfo.filterNonSignificantChanges(
		lastReportedLocal as sysInfo.SystemInfo,
		stateForReport.local as sysInfo.SystemInfo,
	);
	diff.local = _.omit(diff.local, toOmit);
	return _.omitBy(diff, _.isEmpty);
};

const report = _.throttle(async () => {
	const conf = await config.getMany([
		'deviceId',
		'apiTimeout',
		'apiEndpoint',
		'uuid',
		'localMode',
	]);

	const stateDiff = getStateDiff();
	if (_.size(stateDiff) === 0) {
		return 0;
	}

	const { apiEndpoint, uuid, localMode } = conf;
	if (uuid == null || apiEndpoint == null) {
		throw new InternalInconsistencyError(
			'No uuid or apiEndpoint provided to ApiBinder.report',
		);
	}

	try {
		await sendReportPatch(stateDiff, { apiEndpoint, uuid, localMode });

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
			const info = await sysInfo.getSysInfoToReport();
			stateForReport.local = {
				...stateForReport.local,
				...currentDeviceState.local,
				...info,
			};
			stateForReport.dependent = {
				...stateForReport.dependent,
				...currentDeviceState.dependent,
			};

			const stateDiff = getStateDiff();
			if (_.size(stateDiff) === 0) {
				reportPending = false;
				return null;
			}

			await report();
			reportCurrentState();
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
	// But check once every max report frequency to ensure that changes in system
	// info are picked up (CPU temp etc)
	setInterval(doReport, constants.maxReportFrequency);
	return reportCurrentState();
};
