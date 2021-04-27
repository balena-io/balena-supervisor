import * as Bluebird from 'bluebird';
import { NextFunction, Response, Router } from 'express';
import * as _ from 'lodash';

import * as deviceState from '../device-state';
import * as apiBinder from '../api-binder';
import * as applicationManager from '../compose/application-manager';
import {
	CompositionStepAction,
	generateStep,
} from '../compose/composition-steps';
import { getApp } from '../device-state/db-format';
import { Service } from '../compose/service';
import Volume from '../compose/volume';
import * as commitStore from '../compose/commit';
import * as config from '../config';
import * as db from '../db';
import * as deviceConfig from '../device-config';
import * as logger from '../logger';
import * as images from '../compose/images';
import * as volumeManager from '../compose/volume-manager';
import * as serviceManager from '../compose/service-manager';
import { spawnJournalctl } from '../lib/journald';
import {
	appNotFoundMessage,
	serviceNotFoundMessage,
	v2ServiceEndpointInputErrorMessage,
} from '../lib/messages';
import log from '../lib/supervisor-console';
import supervisorVersion from '../lib/supervisor-version';
import { checkInt, checkTruthy } from '../lib/validation';
import { isVPNActive } from '../network';
import { doPurge, doRestart, safeStateClone } from './common';
import { AuthorizedRequest } from '../lib/api-keys';

export function createV2Api(router: Router) {
	const handleServiceAction = (
		req: AuthorizedRequest,
		res: Response,
		next: NextFunction,
		action: CompositionStepAction,
	): Resolvable<void> => {
		const { imageId, serviceName, force } = req.body;
		const appId = checkInt(req.params.appId);
		if (!appId) {
			res.status(400).json({
				status: 'failed',
				message: 'Missing app id',
			});
			return;
		}

		// handle the case where the appId is out of scope
		if (!req.auth.isScoped({ apps: [appId] })) {
			res.status(401).json({
				status: 'failed',
				message: 'Application is not available',
			});
			return;
		}

		return Promise.all([applicationManager.getCurrentApps(), getApp(appId)])
			.then(([apps, targetApp]) => {
				const app = apps[appId];

				if (app == null) {
					res.status(404).send(appNotFoundMessage);
					return;
				}

				// Work if we have a service name or an image id
				if (imageId == null && serviceName == null) {
					throw new Error(v2ServiceEndpointInputErrorMessage);
				}

				let service: Service | undefined;
				let targetService: Service | undefined;
				if (imageId != null) {
					service = _.find(app.services, { imageId });
					targetService = _.find(targetApp.services, { imageId });
				} else {
					service = _.find(app.services, { serviceName });
					targetService = _.find(targetApp.services, { serviceName });
				}
				if (service == null) {
					res.status(404).send(serviceNotFoundMessage);
					return;
				}

				applicationManager.setTargetVolatileForService(service.imageId!, {
					running: action !== 'stop',
				});
				return applicationManager
					.executeStep(
						generateStep(action, {
							current: service,
							target: targetService,
							wait: true,
						}),
						{
							force,
						},
					)
					.then(() => {
						res.status(200).send('OK');
					});
			})
			.catch(next);
	};

	const createServiceActionHandler = (action: string) =>
		_.partial(handleServiceAction, _, _, _, action);

	router.post(
		'/v2/applications/:appId/purge',
		(req: AuthorizedRequest, res: Response, next: NextFunction) => {
			const { force } = req.body;
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: 'Missing app id',
				});
			}

			// handle the case where the application is out of scope
			if (!req.auth.isScoped({ apps: [appId] })) {
				res.status(401).json({
					status: 'failed',
					message: 'Application is not available',
				});
				return;
			}

			return doPurge(appId, force)
				.then(() => {
					res.status(200).send('OK');
				})
				.catch(next);
		},
	);

	router.post(
		'/v2/applications/:appId/restart-service',
		createServiceActionHandler('restart'),
	);

	router.post(
		'/v2/applications/:appId/stop-service',
		createServiceActionHandler('stop'),
	);

	router.post(
		'/v2/applications/:appId/start-service',
		createServiceActionHandler('start'),
	);

	router.post(
		'/v2/applications/:appId/restart',
		(req: AuthorizedRequest, res: Response, next: NextFunction) => {
			const { force } = req.body;
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: 'Missing app id',
				});
			}

			// handle the case where the appId is out of scope
			if (!req.auth.isScoped({ apps: [appId] })) {
				res.status(401).json({
					status: 'failed',
					message: 'Application is not available',
				});
				return;
			}

			return doRestart(appId, force)
				.then(() => {
					res.status(200).send('OK');
				})
				.catch(next);
		},
	);

	// TODO: Support dependent applications when this feature is complete
	router.get(
		'/v2/applications/state',
		async (req: AuthorizedRequest, res: Response, next: NextFunction) => {
			// It's kinda hacky to access the services and db via the application manager
			// maybe refactor this code
			Bluebird.join(
				serviceManager.getStatus(),
				images.getStatus(),
				db.models('app').select(['appId', 'commit', 'name']),
				(
					services,
					imgs,
					apps: Array<{ appId: string; commit: string; name: string }>,
				) => {
					// Create an object which is keyed my application name
					const response: {
						[appName: string]: {
							appId: number;
							commit: string;
							services: {
								[serviceName: string]: {
									status?: string;
									releaseId: number;
									downloadProgress: number | null;
								};
							};
						};
					} = {};

					const appNameById: { [id: number]: string } = {};

					// only access scoped apps
					apps
						.filter((app) =>
							req.auth.isScoped({ apps: [parseInt(app.appId, 10)] }),
						)
						.forEach((app) => {
							const appId = parseInt(app.appId, 10);
							response[app.name] = {
								appId,
								commit: app.commit,
								services: {},
							};

							appNameById[appId] = app.name;
						});

					// only access scoped images
					imgs
						.filter((img) => req.auth.isScoped({ apps: [img.appId] }))
						.forEach((img) => {
							const appName = appNameById[img.appId];
							if (appName == null) {
								log.warn(
									`Image found for unknown application!\nImage: ${JSON.stringify(
										img,
									)}`,
								);
								return;
							}

							const svc = _.find(services, (service: Service) => {
								return service.imageId === img.imageId;
							});

							let status: string | undefined;
							if (svc == null) {
								status = img.status;
							} else {
								status = svc.status || img.status;
							}
							response[appName].services[img.serviceName] = {
								status,
								releaseId: img.releaseId,
								downloadProgress: img.downloadProgress || null,
							};
						});

					res.status(200).json(response);
				},
			).catch(next);
		},
	);

	router.get(
		'/v2/applications/:appId/state',
		async (req: AuthorizedRequest, res: Response) => {
			// Check application ID provided is valid
			const appId = checkInt(req.params.appId);
			if (!appId) {
				return res.status(400).json({
					status: 'failed',
					message: `Invalid application ID: ${req.params.appId}`,
				});
			}

			// Query device for all applications
			let apps: any;
			try {
				apps = await applicationManager.getStatus();
			} catch (e) {
				log.error(e.message);
				return res.status(500).json({
					status: 'failed',
					message: `Unable to retrieve state for application ID: ${appId}`,
				});
			}
			// Check if the application exists
			if (!(appId in apps.local) || !req.auth.isScoped({ apps: [appId] })) {
				return res.status(409).json({
					status: 'failed',
					message: `Application ID does not exist: ${appId}`,
				});
			}

			// handle the case where the appId is out of scope
			if (!req.auth.isScoped({ apps: [appId] })) {
				res.status(401).json({
					status: 'failed',
					message: 'Application is not available',
				});
				return;
			}

			// Filter applications we do not want
			for (const app in apps.local) {
				if (app !== appId.toString()) {
					delete apps.local[app];
				}
			}

			const commit = await commitStore.getCommitForApp(appId);

			// Return filtered applications
			return res.status(200).json({ commit, ...apps });
		},
	);

	router.get('/v2/local/target-state', async (_req, res) => {
		const targetState = await deviceState.getTarget();
		const target = safeStateClone(targetState);

		res.status(200).json({
			status: 'success',
			state: target,
		});
	});

	router.post('/v2/local/target-state', async (req, res) => {
		// let's first ensure that we're in local mode, otherwise
		// this function should not do anything
		const localMode = await config.get('localMode');
		if (!localMode) {
			return res.status(400).json({
				status: 'failed',
				message: 'Target state can only set when device is in local mode',
			});
		}

		// Now attempt to set the state
		const force = req.body.force;
		const targetState = req.body;
		try {
			await deviceState.setTarget(targetState, true);
			await deviceState.triggerApplyTarget({ force });
			res.status(200).json({
				status: 'success',
				message: 'OK',
			});
		} catch (e) {
			res.status(400).json({
				status: 'failed',
				message: e.message,
			});
		}
	});

	router.get('/v2/local/device-info', async (_req, res) => {
		try {
			const { deviceType, deviceArch } = await config.getMany([
				'deviceType',
				'deviceArch',
			]);

			return res.status(200).json({
				status: 'success',
				info: {
					arch: deviceArch,
					deviceType,
				},
			});
		} catch (e) {
			res.status(500).json({
				status: 'failed',
				message: e.message,
			});
		}
	});

	router.get('/v2/local/logs', async (_req, res) => {
		const serviceNameCache: { [sId: number]: string } = {};
		const backend = logger.getLocalBackend();
		// Cache the service names to IDs per call to the endpoint
		backend.assignServiceNameResolver(async (id: number) => {
			if (id in serviceNameCache) {
				return serviceNameCache[id];
			} else {
				const name = await applicationManager.serviceNameFromId(id);
				serviceNameCache[id] = name;
				return name;
			}
		});

		// Get the stream, and stream it into res
		const listenStream = backend.attachListener();

		// The http connection doesn't correctly intialise until some data is sent,
		// which means any callers waiting on the data being returned will hang
		// until the first logs comes through. To avoid this we send an initial
		// message
		res.write(
			`${JSON.stringify({ message: 'Streaming logs', isSystem: true })}\n`,
		);
		listenStream.pipe(res);
	});

	router.get('/v2/version', (_req, res) => {
		res.status(200).json({
			status: 'success',
			version: supervisorVersion,
		});
	});

	router.get('/v2/containerId', async (req: AuthorizedRequest, res) => {
		const services = (await serviceManager.getAll()).filter((service) =>
			req.auth.isScoped({ apps: [service.appId] }),
		);

		if (req.query.serviceName != null || req.query.service != null) {
			const serviceName = req.query.serviceName || req.query.service;
			const service = _.find(
				services,
				(svc) => svc.serviceName === serviceName,
			);
			if (service != null) {
				res.status(200).json({
					status: 'success',
					containerId: service.containerId,
				});
			} else {
				res.status(503).json({
					status: 'failed',
					message: 'Could not find service with that name',
				});
			}
		} else {
			res.status(200).json({
				status: 'success',
				services: _(services)
					.keyBy('serviceName')
					.mapValues('containerId')
					.value(),
			});
		}
	});

	router.get('/v2/state/status', async (req: AuthorizedRequest, res) => {
		const appIds: number[] = [];
		const pending = deviceState.isApplyInProgress();
		const containerStates = (await serviceManager.getAll())
			.filter((service) => req.auth.isScoped({ apps: [service.appId] }))
			.map((svc) => {
				appIds.push(svc.appId);
				return _.pick(
					svc,
					'status',
					'serviceName',
					'appId',
					'imageId',
					'serviceId',
					'containerId',
					'createdAt',
				);
			});

		let downloadProgressTotal = 0;
		let downloads = 0;
		const imagesStates = (await images.getStatus())
			.filter((img) => req.auth.isScoped({ apps: [img.appId] }))
			.map((img) => {
				appIds.push(img.appId);
				if (img.downloadProgress != null) {
					downloadProgressTotal += img.downloadProgress;
					downloads += 1;
				}
				return _.pick(
					img,
					'name',
					'appId',
					'serviceName',
					'imageId',
					'dockerImageId',
					'status',
					'downloadProgress',
				);
			});

		let overallDownloadProgress: number | null = null;
		if (downloads > 0) {
			overallDownloadProgress = downloadProgressTotal / downloads;
		}

		// This endpoint does not support multi-app but the device might be running multiple apps
		// We must return information for only 1 application so use the first one in the list
		const appId = appIds[0];
		// Get the commit for this application
		const commit = await commitStore.getCommitForApp(appId);
		// Filter containers by this application
		const appContainers = containerStates.filter((c) => c.appId === appId);
		// Filter images by this application
		const appImages = imagesStates.filter((i) => i.appId === appId);

		return res.status(200).send({
			status: 'success',
			appState: pending ? 'applying' : 'applied',
			overallDownloadProgress,
			containers: appContainers,
			images: appImages,
			release: commit,
		});
	});

	router.get('/v2/device/name', async (_req, res) => {
		const deviceName = await config.get('name');
		res.json({
			status: 'success',
			deviceName,
		});
	});

	router.get('/v2/device/tags', async (_req, res) => {
		try {
			const tags = await apiBinder.fetchDeviceTags();
			return res.json({
				status: 'success',
				tags,
			});
		} catch (e) {
			log.error(e);
			res.status(500).json({
				status: 'failed',
				message: e.message,
			});
		}
	});

	router.get('/v2/device/vpn', async (_req, res) => {
		const conf = await deviceConfig.getCurrent();
		// Build VPNInfo
		const info = {
			enabled: conf.SUPERVISOR_VPN_CONTROL === 'true',
			connected: await isVPNActive(),
		};
		// Return payload
		return res.json({
			status: 'success',
			vpn: info,
		});
	});

	router.get('/v2/cleanup-volumes', async (req: AuthorizedRequest, res) => {
		const targetState = await applicationManager.getTargetApps();
		const referencedVolumes: string[] = [];
		_.each(targetState, (app, appId) => {
			// if this app isn't in scope of the request, do not cleanup it's volumes
			if (!req.auth.isScoped({ apps: [parseInt(appId, 10)] })) {
				return;
			}

			_.each(app.volumes, (_volume, volumeName) => {
				referencedVolumes.push(
					Volume.generateDockerName(parseInt(appId, 10), volumeName),
				);
			});
		});
		await volumeManager.removeOrphanedVolumes(referencedVolumes);
		res.json({
			status: 'success',
		});
	});

	router.post('/v2/journal-logs', (req, res) => {
		const all = checkTruthy(req.body.all);
		const follow = checkTruthy(req.body.follow);
		const count = checkInt(req.body.count, { positive: true }) || undefined;
		const unit = req.body.unit;
		const format = req.body.format || 'short';
		const containerId = req.body.containerId;

		const journald = spawnJournalctl({
			all,
			follow,
			count,
			unit,
			format,
			containerId,
		});
		res.status(200);
		// We know stdout will be present
		journald.stdout!.pipe(res);
		res.on('close', () => {
			journald.kill('SIGKILL');
		});
		journald.on('exit', () => {
			journald.stdout!.unpipe();
			res.end();
		});
	});
}
