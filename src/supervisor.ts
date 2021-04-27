import * as apiBinder from './api-binder';
import * as db from './db';
import * as config from './config';
import * as deviceState from './device-state';
import * as eventTracker from './event-tracker';
import { intialiseContractRequirements } from './lib/contracts';
import { normaliseLegacyDatabase } from './lib/migration';
import * as osRelease from './lib/os-release';
import * as logger from './logger';
import SupervisorAPI from './supervisor-api';

import log from './lib/supervisor-console';
import version from './lib/supervisor-version';

import * as avahi from './lib/avahi';
import * as firewall from './lib/firewall';
import logMonitor from './logging/monitor';

const startupConfigFields: config.ConfigKey[] = [
	'uuid',
	'listenPort',
	'apiEndpoint',
	'apiTimeout',
	'unmanaged',
	'deviceApiKey',
	'mixpanelToken',
	'mixpanelHost',
	'loggingEnabled',
	'localMode',
	'legacyAppsPresent',
];

export class Supervisor {
	private api: SupervisorAPI;

	public async init() {
		log.info(`Supervisor v${version} starting up...`);

		await db.initialized;
		await config.initialized;
		await eventTracker.initialized;
		await avahi.initialized;
		log.debug('Starting logging infrastructure');
		await logger.initialized;

		const conf = await config.getMany(startupConfigFields);

		intialiseContractRequirements({
			supervisorVersion: version,
			deviceType: await config.get('deviceType'),
			l4tVersion: await osRelease.getL4tVersion(),
		});

		log.info('Starting firewall');
		await firewall.initialised;

		log.debug('Starting api binder');
		await apiBinder.initialized;

		await deviceState.initialized;

		logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start');
		if (conf.legacyAppsPresent && apiBinder.balenaApi != null) {
			log.info('Legacy app detected, running migration');
			await normaliseLegacyDatabase();
		}

		await deviceState.loadInitialState();

		log.info('Starting API server');
		this.api = new SupervisorAPI({
			routers: [apiBinder.router, deviceState.router],
			healthchecks: [apiBinder.healthcheck, deviceState.healthcheck],
		});
		this.api.listen(conf.listenPort, conf.apiTimeout);
		deviceState.on('shutdown', () => this.api.stop());

		await apiBinder.start();

		logMonitor.start();
	}
}

export default Supervisor;
