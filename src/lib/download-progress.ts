import * as _ from 'lodash';
import blink = require('./blink');
import { DeviceStatus, TargetState } from '../types/state';
import * as deviceState from '../device-state';
import * as targetState from '../device-state/target-state';

interface ServiceState {
	id: string;
	status: string;
	download_progress: number | null;
}

const DOWNLOAD_BLINK_THROTTLE = 10000;
const DOWNLOAD_BLINK_PERIOD_BASE = 100;
const DOWNLOAD_BLINK_PERIOD_STEP = 10;

const throttledBlink = _.throttle((progress: number) => {
	blink.pattern.stop();
	if (progress < 100) {
		blink.pattern.start({
			blinks: 1,
			pause: 0,
			onDuration:
				DOWNLOAD_BLINK_PERIOD_BASE + DOWNLOAD_BLINK_PERIOD_STEP * progress,
			offDuration:
				DOWNLOAD_BLINK_PERIOD_BASE + DOWNLOAD_BLINK_PERIOD_STEP * progress,
		});
	}
}, DOWNLOAD_BLINK_THROTTLE);

export async function downloadProgress() {
	const currentDeviceState = await deviceState.getStatus();

	if (currentDeviceState.local?.update_pending) {
		// Get target services and current state
		const targetDeviceState = await targetState.get();
		const targetServicesIDs = getTargetServicesIds(targetDeviceState);
		const currentServicesStates = getCurrentServicesStates(currentDeviceState);

		// Calculate overall progress
		let progress = 0;
		for (const id of targetServicesIDs) {
			const service = currentServicesStates.find((s) => s.id === id);
			if (service) {
				if (['Downloaded', 'Installing', 'Running'].includes(service.status)) {
					// States after 'Downloading' report 'null' download_progress. Patch those to 100%
					progress += 100;
				} else {
					progress += service.download_progress ?? 0;
				}
			}
		}
		progress /= targetServicesIDs.length;

		// Blink!
		throttledBlink(progress);
	} else {
		blink.pattern.stop();
	}
}

function getTargetServicesIds(target: TargetState): string[] {
	const servicesStatus: string[] = [];
	_.toPairs(target.local?.apps).map(([, app]) => {
		_.toPairs(app.services).map(([, service]) => {
			servicesStatus.push(service.imageId.toString());
		});
	});

	return servicesStatus;
}

function getCurrentServicesStates(current: DeviceStatus): ServiceState[] {
	const serviceStatus: ServiceState[] = [];
	_.toPairs(current.local?.apps).map(([, app]) => {
		_.toPairs(app).map(([, service]) => {
			_.toPairs(service).map(([id, serviceDetails]) => {
				serviceStatus.push({
					id,
					status: serviceDetails.status,
					download_progress: serviceDetails.download_progress,
				});
			});
		});
	});

	return serviceStatus;
}
