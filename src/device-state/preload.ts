import * as _ from 'lodash';
import { promises as fs } from 'fs';

import { Image, imageFromService } from '../compose/images';
import * as deviceState from '../device-state';
import * as config from '../config';
import * as deviceConfig from '../device-config';
import * as eventTracker from '../event-tracker';
import * as images from '../compose/images';

import constants = require('../lib/constants');
import { AppsJsonParseError, EISDIR, ENOENT } from '../lib/errors';
import log from '../lib/supervisor-console';

import { convertLegacyAppsJson } from '../lib/migration';
import { AppsJsonFormat } from '../types/state';

export async function loadTargetFromFile(
	appsPath: Nullable<string>,
): Promise<void> {
	log.info('Attempting to load any preloaded applications');
	if (!appsPath) {
		appsPath = constants.appsJsonPath;
	}

	try {
		const content = await fs.readFile(appsPath, 'utf8');

		// It's either a target state or it's a list of legacy
		// style application definitions, we reconcile this below
		let stateFromFile: AppsJsonFormat | any[];
		try {
			stateFromFile = JSON.parse(content);
		} catch (e) {
			throw new AppsJsonParseError(e);
		}

		if (_.isArray(stateFromFile)) {
			log.debug('Detected a legacy apps.json, converting...');
			stateFromFile = convertLegacyAppsJson(stateFromFile as any[]);
		}
		const preloadState = stateFromFile as AppsJsonFormat;

		let commitToPin: string | undefined;
		let appToPin: number | undefined;

		if (_.isEmpty(preloadState)) {
			return;
		}

		const imgs: Image[] = [];
		const uuids = _.keys(preloadState.apps);

		for (const uuid of uuids) {
			const app = preloadState.apps[uuid];

			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible
			commitToPin = app.commit;
			appToPin = app.appId;
			const serviceIds = _.keys(app.services);

			for (const serviceId of serviceIds) {
				const service = app.services[serviceId];

				const svc = {
					imageName: service.image,
					serviceName: service.serviceName,
					imageId: service.imageId,
					serviceId: parseInt(serviceId, 10),
					releaseId: app.releaseId,
					appId: app.appId,
					uuid,
				};
				imgs.push(imageFromService(svc));
			}
		}

		for (const image of imgs) {
			const name = await images.normalise(image.name);
			image.name = name;
			// TODO: the only reason for adding the images to the database here
			// is to prevent downloading images if for any reason they are not there
			// when starting from a preloading state. But if they are not there, isn't
			// that really a preload issue?
			// await images.save(image);
		}

		const deviceConf = await deviceConfig.getCurrent();
		const formattedConf = deviceConfig.formatConfigKeys(preloadState.config);
		preloadState.config = { ...formattedConf, ...deviceConf };
		const localState = {
			local: { name: '', ...preloadState },
			dependent: { apps: [], devices: [] },
		};

		await deviceState.setTarget(localState);
		log.success('Preloading complete');
		if (preloadState.pinDevice) {
			// Multi-app warning!
			// The following will need to be changed once running
			// multiple applications is possible
			if (commitToPin != null && appToPin != null) {
				log.debug('Device will be pinned');
				await config.set({
					pinDevice: {
						commit: commitToPin,
						app: appToPin,
					},
				});
			}
		}
	} catch (e) {
		// Ensure that this is actually a file, and not an empty path
		// It can be an empty path because if the file does not exist
		// on host, the docker daemon creates an empty directory when
		// the bind mount is added
		if (ENOENT(e) || EISDIR(e)) {
			log.debug('No apps.json file present, skipping preload');
		} else {
			eventTracker.track('Loading preloaded apps failed', {
				error: e,
			});
		}
	}
}
