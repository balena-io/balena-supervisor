import * as _ from 'lodash';
import App from '../../src/compose/app';

import Network from '../../src/compose/network';
import Service from '../../src/compose/service';
import { ServiceComposeConfig } from '../../src/compose/types/service';
import Volume from '../../src/compose/volume';

export function createApp(
	services: Service[],
	networks: Network[],
	volumes: Volume[],
	target: boolean,
	appId = 1,
) {
	return new App(
		{
			appId,
			services,
			networks: _.keyBy(networks, 'name'),
			volumes: _.keyBy(volumes, 'name'),
		},
		target,
	);
}

export async function createService(
	conf: Partial<ServiceComposeConfig>,
	appId = 1,
	serviceName = 'test',
	releaseId = 2,
	serviceId = 3,
	imageId = 4,
	uuid?: string,
	extraState?: Partial<Service>,
) {
	if (uuid == null) {
		// Now that we match on UUID, make sure previous tests don't break by having
		// the uuid the same based on the appId
		uuid = `uuid${appId}`;
	}
	const svc = await Service.fromComposeObject(
		{
			appId,
			serviceName,
			releaseId,
			serviceId,
			imageId,
			uuid,
			...conf,
		},
		{} as any,
	);
	if (extraState != null) {
		for (const k of Object.keys(extraState)) {
			(svc as any)[k] = (extraState as any)[k];
		}
	}
	return svc;
}
