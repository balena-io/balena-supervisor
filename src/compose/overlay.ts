import * as _ from 'lodash';
import * as readline from 'readline';
import type { ContainerInfo } from 'dockerode';

import { docker } from '../lib/docker-utils';
import * as host from '../lib/host-utils';
import * as logger from '../logger';
import * as LogTypes from '../lib/log-types';
import App from './app';
import Service from './service';
import type { CompositionStep } from './composition-steps';
import * as images from './images';
import type { Image } from './images';
import log from '../lib/supervisor-console';

class Overlay {
	serviceName: string;
	appId: number;
	appUuid: string;
	image: string;
	dockerImageId: string;

	private constructor() {}

	public static fromDockerContainer(container: ContainerInfo): Overlay {
		const ext = new Overlay();
		ext.serviceName = container.Labels['io.balena.service-name'];
		ext.appId = parseInt(container.Labels['io.balena.app-id'], 10);
		ext.appUuid = container.Labels['io.balena.app-uuid'];

		// TODO: for preloaded extensions, image does not correspond to the image digest
		ext.image = container.Image;
		ext.dockerImageId = container.ImageID;

		return ext;
	}

	public static fromService(service: Service): Overlay {
		const ext = new Overlay();

		// serviceName, appId and appUuid are not being created by the script
		// if we move to supervisor managed host extensions, they will be there
		ext.serviceName = service.serviceName!;
		ext.appId = service.appId;
		ext.image = service.imageName!;
		ext.appUuid = service.uuid!;
		ext.dockerImageId = service.config.image;

		return ext;
	}
}

export async function getRequiredSteps(
	targetState: Dictionary<App>,
	_availableImages: Image[],
	_downloading: number[],
): Promise<CompositionStep[]> {
	// In the future we want the supervisor to do these extension installations
	// itself (i.e. fetch images, tag them, tear down old containers, create new ones, reboot) but for
	// now, we send the list of images to a helper script on the OS which handles
	// it for us

	const installedExtensions = await getCurrent();
	// Get a list of all target extensions not in the current state
	const toInstall = extensionImagesToInstall(targetState, installedExtensions);
	// Get a list of all current extensions not in the target state
	const toRemove = extensionContainersToRemove(
		targetState,
		installedExtensions,
	);
	const steps: CompositionStep[] = [];

	// If target images do not match currently installed images, we need to call
	// the script with the new target
	if (toInstall.length > 0 || toRemove.length > 0) {
		steps.push({
			action: 'updateHostExtensions',
			target: _.flatMap(targetState, (app) =>
				app.services.map((svc) => images.imageFromService(svc)),
			),
		});
	}

	return steps;
}

export async function update(target: Image[]) {
	const args: string[] = [];
	if (target.length > 0) {
		args.push('-t');
		// TODO: appUuid is not necessary after all for this type of call
		target.forEach((image) => args.push([image.appId, image.name].join(':')));
	}

	logger.logSystemEvent(LogTypes.hostExtensionUpdate, {
		extensions: target.map((image) => image.name),
	});

	// Call the update script and wait for the process to finish
	await new Promise((resolve, reject) => {
		const process = host.spawn('update-hostapp-extensions', args);

		// Pass process output to log
		const reader = readline.createInterface({ input: process.stderr! });
		reader.on('line', (line) => log.debug(line));

		process.on('exit', (exitCode) => {
			if (exitCode !== 0) {
				logger.logSystemEvent(LogTypes.hostExtensionUpdateError, {
					error: {
						message: `Host extensions update failed with code ${exitCode}`,
					},
				});

				reject(`Host extensions update failed with code ${exitCode}`);
				return;
			}
			logger.logSystemEvent(LogTypes.hostExtensionUpdateSuccess, {
				extensions: target.map((image) => image.name),
			});
			resolve(exitCode);
		});
	});
}

async function getCurrent(): Promise<Overlay[]> {
	// Find all installed host extensions
	const extensions = (
		await docker.listContainers({
			all: true, // host extensions won't show as running
			filters: { label: ['io.balena.features.host-extension'] },
		})
	)
		.filter((container) => container.State === 'created')
		.map(Overlay.fromDockerContainer);
	return extensions;
}

function extensionImagesToInstall(
	targetState: Dictionary<App>,
	installedExtensions: Overlay[],
): Service[] {
	return _.flatMap(targetState, (app) =>
		app.services.filter(
			(svc) =>
				!_.some(
					installedExtensions,
					(ext) =>
						ext.dockerImageId === svc.config.image ||
						ext.image === svc.imageName!,
				),
		),
	);
}

function extensionContainersToRemove(
	targetState: Dictionary<App>,
	installedExtensions: Overlay[],
): Overlay[] {
	return installedExtensions.filter(
		(ext) =>
			!_.some(
				_.flatMap(targetState, (app) => app.services),
				(svc) =>
					ext.dockerImageId === svc.config.image ||
					ext.image === svc.imageName!,
			),
	);
}
