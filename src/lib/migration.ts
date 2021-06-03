import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as rimraf from 'rimraf';

const rimrafAsync = Bluebird.promisify(rimraf);

import * as apiBinder from '../api-binder';
import * as config from '../config';
import * as db from '../db';
import * as volumeManager from '../compose/volume-manager';
import * as serviceManager from '../compose/service-manager';
import * as deviceState from '../device-state';
import * as applicationManager from '../compose/application-manager';
import * as constants from '../lib/constants';
import {
	BackupError,
	DatabaseParseError,
	NotFoundError,
	InternalInconsistencyError,
} from '../lib/errors';
import { docker } from '../lib/docker-utils';
import { exec, pathExistsOnHost, mkdirp } from '../lib/fs-utils';
import { log } from '../lib/supervisor-console';
import type {
	AppsJsonFormat,
	TargetApplication,
	TargetState,
} from '../types/state';
import type { DatabaseApp } from '../device-state/target-state-cache';

export const defaultLegacyVolume = () => 'resin-data';

export function singleToMulticontainerApp(
	app: Dictionary<any>,
): TargetApplication {
	const environment: Dictionary<string> = {};
	for (const key in app.env) {
		if (!/^RESIN_/.test(key)) {
			environment[key] = app.env[key];
		}
	}

	const { appId } = app;
	const conf = app.config != null ? app.config : {};
	const newApp: TargetApplication = {
		appId,
		commit: app.commit,
		name: app.name,
		releaseId: 1,
		releaseVersion: app.commit,
		networks: {},
		volumes: {},
		services: {},
	};
	const defaultVolume = exports.defaultLegacyVolume();
	newApp.volumes[defaultVolume] = {};
	const updateStrategy =
		conf['RESIN_SUPERVISOR_UPDATE_STRATEGY'] != null
			? conf['RESIN_SUPERVISOR_UPDATE_STRATEGY']
			: 'download-then-kill';
	const handoverTimeout =
		conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT'] != null
			? conf['RESIN_SUPERVISOR_HANDOVER_TIMEOUT']
			: '';
	const restartPolicy =
		conf['RESIN_APP_RESTART_POLICY'] != null
			? conf['RESIN_APP_RESTART_POLICY']
			: 'always';
	newApp.services = {
		// Disable the next line, as this *has* to be a string
		// tslint:disable-next-line
		'1': {
			appId,
			serviceName: 'main',
			imageId: 1,
			commit: app.commit,
			releaseId: 1,
			image: app.imageId,
			privileged: true,
			networkMode: 'host',
			volumes: [`${defaultVolume}:/data`],
			labels: {
				'io.resin.features.kernel-modules': '1',
				'io.resin.features.firmware': '1',
				'io.resin.features.dbus': '1',
				'io.resin.features.supervisor-api': '1',
				'io.resin.features.resin-api': '1',
				'io.resin.update.strategy': updateStrategy,
				'io.resin.update.handover-timeout': handoverTimeout,
				'io.resin.legacy-container': '1',
			},
			environment,
			restart: restartPolicy,
			running: true,
		},
	};
	return newApp;
}

export function convertLegacyAppsJson(appsArray: any[]): AppsJsonFormat {
	const deviceConfig = _.reduce(
		appsArray,
		(conf, app) => {
			return _.merge({}, conf, app.config);
		},
		{},
	);

	const apps = _.keyBy(_.map(appsArray, singleToMulticontainerApp), 'appId');
	return { apps, config: deviceConfig } as AppsJsonFormat;
}

export async function normaliseLegacyDatabase() {
	await apiBinder.initialized;
	await deviceState.initialized;

	if (apiBinder.balenaApi == null) {
		throw new InternalInconsistencyError(
			'API binder is not initialized correctly',
		);
	}

	// When legacy apps are present, we kill their containers and migrate their /data to a named volume
	log.info('Migrating ids for legacy app...');

	const apps: DatabaseApp[] = await db.models('app').select();

	if (apps.length === 0) {
		log.debug('No app to migrate');
		return;
	}

	for (const app of apps) {
		let services: Array<TargetApplication['services']['']>;

		try {
			services = JSON.parse(app.services);
		} catch (e) {
			throw new DatabaseParseError(e);
		}

		// Check there's a main service, with legacy-container set
		if (services.length !== 1) {
			log.debug("App doesn't have a single service, ignoring");
			return;
		}

		const service = services[0];
		if (
			!service.labels['io.resin.legacy-container'] &&
			!service.labels['io.balena.legacy-container']
		) {
			log.debug('Service is not marked as legacy, ignoring');
			return;
		}

		log.debug(`Getting release ${app.commit} for app ${app.appId} from API`);
		const releases = await apiBinder.balenaApi.get({
			resource: 'release',
			options: {
				$filter: {
					belongs_to__application: app.appId,
					commit: app.commit,
					status: 'success',
				},
				$expand: {
					contains__image: {
						$expand: 'image',
					},
				},
			},
		});

		if (releases.length === 0) {
			log.warn(
				`No compatible releases found in API, removing ${app.appId} from target state`,
			);
			await db.models('app').where({ appId: app.appId }).del();
		}

		// We need to get the release.id, serviceId, image.id and updated imageUrl
		const release = releases[0];
		const image = release.contains__image[0].image[0];
		const serviceId = image.is_a_build_of__service.__id;
		const imageUrl = !image.content_hash
			? image.is_stored_at__image_location
			: `${image.is_stored_at__image_location}@${image.content_hash}`;

		log.debug(
			`Found a release with releaseId ${release.id}, imageId ${image.id}, serviceId ${serviceId}\nImage location is ${imageUrl}`,
		);

		const imageFromDocker = await docker
			.getImage(service.image)
			.inspect()
			.catch((error) => {
				if (error instanceof NotFoundError) {
					return;
				}

				throw error;
			});
		const imagesFromDatabase = await db
			.models('image')
			.where({ name: service.image })
			.select();

		await db.transaction(async (trx: db.Transaction) => {
			try {
				if (imagesFromDatabase.length > 0) {
					log.debug('Deleting existing image entry in db');
					await trx('image').where({ name: service.image }).del();
				} else {
					log.debug('No image in db to delete');
				}
			} finally {
				if (imageFromDocker != null) {
					log.debug('Inserting fixed image entry in db');
					await trx('image').insert({
						name: imageUrl,
						appId: app.appId,
						serviceId,
						serviceName: service.serviceName,
						imageId: image.id,
						releaseId: release.id,
						dependent: 0,
						dockerImageId: imageFromDocker.Id,
					});
				} else {
					log.debug('Image is not downloaded, so not saving it to db');
				}

				delete service.labels['io.resin.legacy-container'];
				delete service.labels['io.balena.legacy-container'];

				Object.assign(app, {
					services: JSON.stringify([
						Object.assign(service, {
							image: imageUrl,
							serviceID: serviceId,
							imageId: image.id,
							releaseId: release.id,
						}),
					]),
					releaseId: release.id,
				});

				log.debug('Updating app entry in db');
				log.success('Successfully migrated legacy application');
				await trx('app').update(app).where({ appId: app.appId });
			}
		});
	}

	log.debug('Killing legacy containers');
	await serviceManager.killAllLegacy();
	log.debug('Migrating legacy app volumes');

	await applicationManager.initialized;
	const targetApps = await applicationManager.getTargetApps();

	for (const appId of _.keys(targetApps)) {
		await volumeManager.createFromLegacy(parseInt(appId, 10));
	}

	await config.set({
		legacyAppsPresent: false,
	});
}

export async function loadBackupFromMigration(
	targetState: TargetState,
	retryDelay: number,
): Promise<void> {
	try {
		const exists = await pathExistsOnHost(
			path.join('mnt/data', constants.migrationBackupFile),
		);
		if (!exists) {
			return;
		}
		log.info('Migration backup detected');

		await deviceState.setTarget(targetState);

		// multi-app warning!
		const appId = parseInt(_.keys(targetState.local?.apps)[0], 10);

		if (isNaN(appId)) {
			throw new BackupError('No appId in target state');
		}

		const volumes = targetState.local?.apps?.[appId].volumes;

		const backupPath = path.join(constants.rootMountPoint, 'mnt/data/backup');
		// We clear this path in case it exists from an incomplete run of this function
		await rimrafAsync(backupPath);
		await mkdirp(backupPath);
		await exec(`tar -xzf backup.tgz -C ${backupPath}`, {
			cwd: path.join(constants.rootMountPoint, 'mnt/data'),
		});

		for (const volumeName of await fs.readdir(backupPath)) {
			const statInfo = await fs.stat(path.join(backupPath, volumeName));

			if (!statInfo.isDirectory()) {
				throw new BackupError(
					`Invalid backup: ${volumeName} is not a directory`,
				);
			}

			if (volumes[volumeName] != null) {
				log.debug(`Creating volume ${volumeName} from backup`);
				// If the volume exists (from a previous incomplete run of this restoreBackup), we delete it first
				await volumeManager
					.get({ appId, name: volumeName })
					.then((volume) => {
						return volume.remove();
					})
					.catch((error) => {
						if (error instanceof NotFoundError) {
							return;
						}
						throw error;
					});

				await volumeManager.createFromPath(
					{ appId, name: volumeName },
					volumes[volumeName],
					path.join(backupPath, volumeName),
				);
			} else {
				throw new BackupError(
					`Invalid backup: ${volumeName} is present in backup but not in target state`,
				);
			}
		}

		await rimrafAsync(backupPath);
		await rimrafAsync(
			path.join(
				constants.rootMountPoint,
				'mnt/data',
				constants.migrationBackupFile,
			),
		);
	} catch (err) {
		log.error(`Error restoring migration backup, retrying: ${err}`);

		await Bluebird.delay(retryDelay);
		return loadBackupFromMigration(targetState, retryDelay);
	}
}
