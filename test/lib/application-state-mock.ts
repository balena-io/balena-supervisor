import * as networkManager from '../../src/compose/network-manager';
import * as volumeManager from '../../src/compose/volume-manager';
import * as serviceManager from '../../src/compose/service-manager';
import * as imageManager from '../../src/compose/images';

import Service from '../../src/compose/service';
import Network from '../../src/compose/network';
import Volume from '../../src/compose/volume';

const originalVolGetAll = volumeManager.getAll;
const originalSvcGetAll = serviceManager.getAll;
const originalNetGetAll = networkManager.getAll;
const originalGetDl = imageManager.getDownloadingImageIds;
const originalNeedsClean = imageManager.isCleanupNeeded;
const originalImageAvailable = imageManager.getAvailable;
const originalNetworkReady = networkManager.supervisorNetworkReady;

export function mockManagers(svcs: Service[], vols: Volume[], nets: Network[]) {
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAll = async () => vols;
	// @ts-expect-error Assigning to a RO property
	networkManager.getAll = async () => nets;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getAll = async () => {
		// Filter services that are being removed
		svcs = svcs.filter((s) => s.status !== 'removing');
		// Update Installing containers to Running
		svcs = svcs.map((s) => {
			if (s.status === 'Installing') {
				s.status = 'Running';
			}
			return s;
		});
		console.log('Calling the mock', svcs);
		return svcs;
	};
}

function unmockManagers() {
	// @ts-expect-error Assigning to a RO property
	volumeManager.getAll = originalVolGetAll;
	// @ts-expect-error Assigning to a RO property
	networkManager.getAll = originalNetGetAll;
	// @ts-expect-error Assigning to a RO property
	serviceManager.getAll = originalSvcGetAll;
}

export function mockImages(
	downloading: number[],
	cleanup: boolean,
	available: imageManager.Image[],
) {
	// @ts-expect-error Assigning to a RO property
	imageManager.getDownloadingImageIds = () => {
		return downloading;
	};
	// @ts-expect-error Assigning to a RO property
	imageManager.isCleanupNeeded = async () => cleanup;
	// @ts-expect-error Assigning to a RO property
	imageManager.getAvailable = async () => available;
}

function unmockImages() {
	// @ts-expect-error Assigning to a RO property
	imageManager.getDownloadingImageIds = originalGetDl;
	// @ts-expect-error Assigning to a RO property
	imageManager.isCleanupNeeded = originalNeedsClean;
	// @ts-expect-error Assigning to a RO property
	imageManager.getAvailable = originalImageAvailable;
}

export function mockSupervisorNetwork(exists: boolean) {
	// @ts-expect-error Assigning to a RO property
	networkManager.supervisorNetworkReady = async () => exists;
}

function unmockSupervisorNetwork() {
	// @ts-expect-error Assigning to a RO property
	networkManager.supervisorNetworkReady = originalNetworkReady;
}

export function unmockAll() {
	unmockManagers();
	unmockImages();
	unmockSupervisorNetwork();
}
