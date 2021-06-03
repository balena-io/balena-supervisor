import * as memoizee from 'memoizee';
import { docker } from '../lib/docker-utils';
import * as constants from '../lib/constants';
import log from './supervisor-console';

export type SupervisorMetadata = {
	uuid?: string;
	serviceName?: string;
};

/**
 * Get the metadata from the supervisor container
 *
 * This is needed for the supervisor to identify itself on the target
 * state and on getStatus() in device-state.ts
 *
 * TODO: remove this once the supervisor knows how to update itself
 */
export const getSupervisorMetadata = memoizee(async () => {
	const supervisorService: SupervisorMetadata = {};

	try {
		const container = await docker
			.getContainer(constants.containerId)
			.inspect();

		const { Labels } = container.Config;
		supervisorService.uuid = Labels['io.balena.app-uuid'];
		supervisorService.serviceName = Labels['io.balena.service-name'];
	} catch (e) {
		log.warn(
			`Failed to query supervisor container with id ${constants.containerId}`,
		);
	}
	return supervisorService;
});
