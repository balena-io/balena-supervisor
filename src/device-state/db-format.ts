import * as _ from 'lodash';

import * as db from '../db';
import * as targetStateCache from '../device-state/target-state-cache';

import App from '../compose/app';
import * as images from '../compose/images';

import {
	InstancedAppState,
	TargetApplication,
	TargetApplications,
	TargetApplicationService,
	TargetState,
} from '../types/state';
import { checkInt } from '../lib/validation';

type InstancedApp = InstancedAppState[0];

// Fetch and instance an app from the db. Throws if the requested appId cannot be found.
// Currently this function does quite a bit more than it needs to as it pulls in a bunch
// of required information for the instances but we should think about a method of not
// requiring that data here
export async function getApp(id: number): Promise<InstancedApp> {
	const dbApp = await getDBEntry(id);
	return await App.fromTargetState(dbApp);
}

export async function getApps(): Promise<InstancedAppState> {
	const dbApps = await getDBEntry();
	const apps: InstancedAppState = {};
	await Promise.all(
		dbApps.map(async (app) => {
			apps[app.appId] = await App.fromTargetState(app);
		}),
	);
	return apps;
}

export async function setApps(
	apps: TargetState['local']['apps'],
	source: string,
	trx?: db.Transaction,
) {
	const dbApps = await Promise.all(
		Object.keys(apps).map(async (uuid) => {
			const app = apps[uuid];
			const services = await Promise.all(
				_.map(app.services, async (s, sId) => ({
					...s,
					appId: app.appId,
					uuid,
					releaseId: app.releaseId,
					releaseVersion: app.releaseVersion,
					serviceId: checkInt(sId),
					commit: app.commit,
					image: await images.normalise(s.image),
				})),
			);

			return {
				uuid,
				appId: app.appId,
				source,
				commit: app.commit,
				name: app.name,
				releaseId: app.releaseId,
				releaseVersion: app.releaseVersion,
				isHost: app.isHost ?? false,
				services: JSON.stringify(services),
				networks: JSON.stringify(app.networks ?? {}),
				volumes: JSON.stringify(app.volumes ?? {}),
			};
		}),
	);
	await targetStateCache.setTargetApps(dbApps, trx);
}

export async function getTargetJson(): Promise<TargetApplications> {
	const dbApps = await getDBEntry();
	const apps: TargetApplications = {};
	await Promise.all(
		dbApps.map(async (app) => {
			const parsedServices = JSON.parse(app.services);

			const services = _(parsedServices)
				.keyBy('serviceId')
				.mapValues(
					(svc: TargetApplicationService) =>
						_.omit(svc, 'commit') as TargetApplicationService,
				)
				.value();

			apps[app.appId] = {
				// We remove the id as this is the supervisor database id, and the
				// source is internal and isn't used except for when we fetch the target
				// state
				..._.omit(app, ['id', 'source']),
				services,
				networks: JSON.parse(app.networks),
				volumes: JSON.parse(app.volumes),
				// We can add this cast because it's required in the db
			} as TargetApplication;
		}),
	);
	return apps;
}

function getDBEntry(): Promise<targetStateCache.DatabaseApp[]>;
function getDBEntry(appId: number): Promise<targetStateCache.DatabaseApp>;
async function getDBEntry(appId?: number) {
	await targetStateCache.initialized;

	return appId != null
		? targetStateCache.getTargetApp(appId)
		: targetStateCache.getTargetApps();
}
