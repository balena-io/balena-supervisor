import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { Dockerfile } from 'livepush';

import * as device from './device';

interface Opts {
	address: string;
	imageName: string;
	imageTag: string;
	docker: Docker;
	dockerfile: Dockerfile;
	nocache: boolean;
	arch?: string;
}

export async function initDevice(opts: Opts) {
	const arch = opts.arch ?? (await device.getDeviceArch(opts.docker));
	const image = `${opts.imageName}-${opts.imageTag}`;

	await device.performBuild(opts.docker, opts.dockerfile, {
		buildargs: { ARCH: arch },
		t: image,
		labels: { 'io.balena.livepush-image': '1', 'io.balena.architecture': arch },
		cachefrom: (await device.getCacheFrom(opts.docker)).concat(image),
		nocache: opts.nocache,
	});

	// Now that we have our new image on the device, we need
	// to stop the supervisor, update
	// /tmp/update-supervisor.conf with our version, and
	// restart the supervisor
	await device.stopSupervisor(opts.address);
	await device.replaceSupervisorImage(opts.address, image, 'latest');
	await device.startSupervisor(opts.address);

	let supervisorContainer: undefined | Docker.ContainerInfo;
	while (supervisorContainer == null) {
		try {
			supervisorContainer = await device.getSupervisorContainer(
				opts.docker,
				true,
			);
		} catch (e) {
			await Bluebird.delay(500);
		}
	}
	return supervisorContainer.Id;
}
