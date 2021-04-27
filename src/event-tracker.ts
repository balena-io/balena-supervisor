import mask = require('json-mask');
import * as _ from 'lodash';
import * as memoizee from 'memoizee';
import * as mixpanel from 'mixpanel';

import * as config from './config';
import log from './lib/supervisor-console';
import supervisorVersion from './lib/supervisor-version';

export type EventTrackProperties = Dictionary<any>;

// The minimum amount of time to wait between sending
// events of the same type
const eventDebounceTime = 60000;

const mixpanelMask = [
	'appId',
	'delay',
	'error',
	'interval',
	'image',
	'app(appId,name)',
	'service(appId,serviceId,serviceName,commit,releaseId,image,labels)',
	'stateDiff/local(os_version,supervisor_version,ip_address,apps/*/services)',
].join(',');

let defaultProperties: EventTrackProperties;
// We must export this for the tests, but we make no references
// to it within the rest of the supervisor codebase
export let client: mixpanel.Mixpanel | null = null;

export const initialized = (async () => {
	await config.initialized;

	const {
		unmanaged,
		mixpanelHost,
		mixpanelToken,
		uuid,
	} = await config.getMany([
		'unmanaged',
		'mixpanelHost',
		'mixpanelToken',
		'uuid',
	]);

	defaultProperties = {
		distinct_id: uuid,
		uuid,
		supervisorVersion,
	};

	if (unmanaged || mixpanelHost == null || mixpanelToken == null) {
		return;
	}
	client = mixpanel.init(mixpanelToken, {
		host: mixpanelHost.host,
		path: mixpanelHost.path,
	});
})();

export async function track(
	event: string,
	properties: EventTrackProperties | Error = {},
) {
	await initialized;

	if (properties instanceof Error) {
		properties = { error: properties };
	}

	properties = _.cloneDeep(properties);
	if (properties.error instanceof Error) {
		// Format the error for printing, to avoid display as { }
		properties.error = {
			message: properties.error.message,
			stack: properties.error.stack,
		};
	}

	// Don't send potentially sensitive information, by using a whitelist
	properties = mask(properties, mixpanelMask);
	log.event('Event:', event, JSON.stringify(properties));
	if (client == null) {
		return;
	}

	properties = assignDefaultProperties(properties);
	throttleddLogger(event)(properties);
}

const throttleddLogger = memoizee(
	(event: string) => {
		// Call this function at maximum once every minute
		return _.throttle(
			(properties: EventTrackProperties | Error) => {
				client?.track(event, properties);
			},
			eventDebounceTime,
			{ leading: true },
		);
	},
	{ primitive: true },
);

function assignDefaultProperties(
	properties: EventTrackProperties,
): EventTrackProperties {
	return _.merge({}, properties, defaultProperties);
}
