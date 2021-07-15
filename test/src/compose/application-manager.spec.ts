import { expect } from 'chai';
import * as sinon from 'sinon';
import { stub } from 'sinon';
import App from '../../../src/compose/app';
import * as applicationManager from '../../../src/compose/application-manager';
import * as imageManager from '../../../src/compose/images';
import { Image } from '../../../src/compose/images';
import Network from '../../../src/compose/network';
import * as networkManager from '../../../src/compose/network-manager';
import Service from '../../../src/compose/service';
import { ServiceComposeConfig } from '../../../src/compose/types/service';
import Volume from '../../../src/compose/volume';
import log from '../../../src/lib/supervisor-console';
import { InstancedAppState } from '../../../src/types/state';

import * as dbHelper from '../../lib/db-helper';

const DEFAULT_NETWORK = Network.fromComposeObject('default', 1, {});

async function createService(
	conf = {} as Partial<ServiceComposeConfig>,
	{
		appId = 1,
		serviceName = 'main',
		releaseId = 1,
		serviceId = 1,
		imageId = 1,
		state = {} as Partial<Service>,
		options = {} as any,
	} = {},
) {
	const svc = await Service.fromComposeObject(
		{
			appId,
			serviceName,
			releaseId,
			serviceId,
			imageId,
			...conf,
		},
		options,
	);

	// Add additonal configuration
	for (const k of Object.keys(state)) {
		(svc as any)[k] = (state as any)[k];
	}
	return svc;
}

function createImage(svc: Service) {
	return {
		dockerImageId: svc.config.image,
		...imageManager.imageFromService(svc),
	};
}

function createApps(
	{
		services = [] as Service[],
		networks = [] as Network[],
		volumes = [] as Volume[],
	},
	target = false,
) {
	const servicesByAppId = services.reduce(
		(svcs, s) => ({ ...svcs, [s.appId]: [s].concat(svcs[s.appId] || []) }),
		{} as Dictionary<Service[]>,
	);
	const volumesByAppId = volumes.reduce(
		(vols, v) => ({ ...vols, [v.appId]: [v].concat(vols[v.appId] || []) }),
		{} as Dictionary<Volume[]>,
	);
	const networksByAppId = networks.reduce(
		(nets, n) => ({ ...nets, [n.appId]: [n].concat(nets[n.appId] || []) }),
		{} as Dictionary<Network[]>,
	);

	const allAppIds = [
		...new Set([
			...Object.keys(servicesByAppId),
			...Object.keys(networksByAppId),
			...Object.keys(volumesByAppId),
		]),
	].map((i) => parseInt(i, 10));

	const apps: InstancedAppState = {};
	for (const appId of allAppIds) {
		apps[appId] = new App(
			{
				appId,
				services: servicesByAppId[appId] ?? [],
				networks: (networksByAppId[appId] ?? []).reduce(
					(nets, n) => ({ ...nets, [n.name]: n }),
					{},
				),
				volumes: (volumesByAppId[appId] ?? []).reduce(
					(vols, v) => ({ ...vols, [v.name]: v }),
					{},
				),
			},
			target,
		);
	}

	return apps;
}

function createCurrentState({
	services = [] as Service[],
	networks = [] as Network[],
	volumes = [] as Volume[],
	images = services.map((s) => createImage(s)) as Image[],
	downloading = [] as number[],
}) {
	const currentApps = createApps({ services, networks, volumes });

	const containerIdsByAppId = services.reduce(
		(ids, s) => ({
			...ids,
			[s.appId]: {
				...ids[s.appId],
				...(s.serviceName &&
					s.containerId && { [s.serviceName]: s.containerId }),
			},
		}),
		{} as { [appId: number]: Dictionary<string> },
	);

	return {
		currentApps,
		availableImages: images,
		downloading,
		containerIdsByAppId,
	};
}

describe('compose/application-manager', () => {
	let testDb: dbHelper.TestDatabase;

	before(async () => {
		testDb = await dbHelper.createDB();

		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');

		// Stub methods that depend on external dependencies
		stub(imageManager, 'isCleanupNeeded');
		stub(networkManager, 'supervisorNetworkReady');
	});

	beforeEach(() => {
		// Do not check for cleanup images by default
		(imageManager.isCleanupNeeded as sinon.SinonStub).resolves(false);
		// Do not check for network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(true);
	});

	afterEach(async () => {
		await testDb.reset();
	});

	after(async () => {
		try {
			await testDb.destroy();
		} catch (e) {
			/* noop */
		}
		// Restore stubbed methods
		sinon.restore();
	});

	it('should init', async () => {
		await applicationManager.initialized;
	});

	// TODO: missing tests for getCurrentApps

	it('infers a start step when all that changes is a running state', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ running: true }, { appId: 1 })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService({ running: false }, { appId: 1 })],
			networks: [DEFAULT_NETWORK],
		});

		const [startStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(startStep).to.have.property('action').that.equals('start');
		expect(startStep)
			.to.have.property('target')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('when a service has to be removed', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService()],
			networks: [DEFAULT_NETWORK],
		});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('infers a fetch step when a service has to be updated', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'image-new' },
						{ appId: 1, imageId: 2, options: {} },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService({}, { appId: 1, imageId: 1 })],
			networks: [DEFAULT_NETWORK],
			images: [],
		});

		const [fetchStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(fetchStep).to.have.property('action').that.equals('fetch');
		expect(fetchStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'image-new' });
	});

	it('does not infer a fetch step when the download is already in progress', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService({ image: 'image-new' }, { appId: 1, imageId: 2 }),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService({}, { appId: 1, imageId: 1 })],
			networks: [DEFAULT_NETWORK],
			downloading: [2],
		});

		const [noopStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(noopStep).to.have.property('action').that.equals('noop');
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers a kill step when a service has to be updated but the strategy is kill-then-download', async () => {
		const labels = {
			'io.balena.update.strategy': 'kill-then-download',
		};
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'image-new', labels },
						{ appId: 1, imageId: 2 },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{ image: 'image-old', labels },
					{ appId: 1, imageId: 1 },
				),
			],
			networks: [DEFAULT_NETWORK],
		});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('does not infer to kill a service with default strategy if a dependency is not downloaded', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image', dependsOn: ['dep'] },
						{
							appId: 1,
							imageId: 3,
							serviceId: 1,
							serviceName: 'main',
							releaseId: 2,
						},
					),
					await createService(
						{ image: 'dep-image' },
						{
							appId: 1,
							imageId: 4,
							serviceId: 2,
							serviceName: 'dep',
							releaseId: 2,
						},
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{ dependsOn: ['dep'] },
					{ appId: 1, imageId: 1, serviceId: 1, serviceName: 'main' },
				),
				await createService(
					{},
					{ appId: 1, imageId: 2, serviceId: 2, serviceName: 'dep' },
				),
			],
			networks: [DEFAULT_NETWORK],
			downloading: [4], // dep-image is still being downloaded
			images: [
				// main-image was already downloaded
				{
					appId: 1,
					releaseId: 2,
					name: 'main-image',
					imageId: 3,
					serviceName: 'main',
					serviceId: 1,
					dependent: 0,
				},
			],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Only noop steps should be seen at this point
		expect(steps.filter((s) => s.action !== 'noop')).to.have.lengthOf(0);
	});

	it('infers to kill several services as long as there is no unmet dependency', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image', dependsOn: ['dep'] },
						{
							appId: 1,
							imageId: 3,
							serviceId: 1,
							serviceName: 'main',
							releaseId: 2,
						},
					),
					await createService(
						{ image: 'dep-image' },
						{
							appId: 1,
							imageId: 4,
							serviceId: 2,
							serviceName: 'dep',
							releaseId: 2,
						},
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{ dependsOn: ['dep'] },
					{ appId: 1, imageId: 1, serviceId: 1, serviceName: 'main' },
				),
				await createService(
					{},
					{ appId: 1, imageId: 2, serviceId: 2, serviceName: 'dep' },
				),
			],
			networks: [DEFAULT_NETWORK],
			images: [
				// Both images have been downloaded
				{
					appId: 1,
					releaseId: 2,
					name: 'main-image',
					imageId: 3,
					serviceName: 'main',
					serviceId: 1,
					dependent: 0,
				},
				{
					appId: 1,
					releaseId: 2,
					name: 'dep-image',
					imageId: 4,
					serviceName: 'dep',
					serviceId: 2,
					dependent: 0,
				},
			],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// We should see kill steps for both currently running services
		expect(
			steps.filter(
				(s: any) => s.action === 'kill' && s.current.serviceName === 'dep',
			),
		).to.have.lengthOf(1);
		expect(
			steps.filter(
				(s: any) => s.action === 'kill' && s.current.serviceName === 'main',
			),
		).to.have.lengthOf(1);
	});

	it('infers to start the dependency first', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image', dependsOn: ['dep'] },
						{
							imageId: 1,
							serviceId: 1,
							serviceName: 'main',
						},
					),
					await createService(
						{ image: 'dep-image' },
						{
							imageId: 2,
							serviceId: 2,
							serviceName: 'dep',
						},
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
			images: [
				// Both images have been downloaded
				{
					appId: 1,
					releaseId: 1,
					name: 'main-image',
					imageId: 1,
					serviceName: 'main',
					serviceId: 1,
					dependent: 0,
				},
				{
					appId: 1,
					releaseId: 1,
					name: 'dep-image',
					imageId: 2,
					serviceName: 'dep',
					serviceId: 2,
					dependent: 0,
				},
			],
		});

		const [startStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(startStep).to.have.property('action').that.equals('start');
		expect(startStep)
			.to.have.property('target')
			.that.deep.includes({ serviceName: 'dep' });

		// No more steps until the first container has been started
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers to start a service once its dependency has been met', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image', dependsOn: ['dep'] },
						{
							imageId: 1,
							serviceId: 1,
							serviceName: 'main',
						},
					),
					await createService(
						{ image: 'dep-image' },
						{
							imageId: 2,
							serviceId: 2,
							serviceName: 'dep',
						},
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);

		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{ image: 'dep-image' },
					{
						imageId: 2,
						serviceId: 2,
						serviceName: 'dep',
					},
				),
			],
			networks: [DEFAULT_NETWORK],
			images: [
				// Both images have been downloaded
				{
					appId: 1,
					releaseId: 1,
					name: 'main-image',
					imageId: 1,
					serviceName: 'main',
					serviceId: 1,
					dependent: 0,
				},
				{
					appId: 1,
					releaseId: 1,
					name: 'dep-image',
					imageId: 2,
					serviceName: 'dep',
					serviceId: 2,
					dependent: 0,
				},
			],
		});

		const [startStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(startStep).to.have.property('action').that.equals('start');
		expect(startStep)
			.to.have.property('target')
			.that.deep.includes({ serviceName: 'main' });

		expect(nextSteps).to.have.lengthOf(0);
	});

	it('infers to remove spurious containers', async () => {
		const targetApps = createApps(
			{
				services: [await createService({ image: 'main-image' })],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{},
					{
						appId: 5,
						serviceName: 'old-service',
					},
				),
			],
			networks: [DEFAULT_NETWORK],
			images: [
				// Both images have been downloaded
				{
					appId: 1,
					releaseId: 1,
					name: 'main-image',
					imageId: 1,
					serviceName: 'main',
					serviceId: 1,
					dependent: 0,
				},
			],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Start the new service
		expect(
			steps.filter(
				(s: any) => s.action === 'start' && s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);

		// Remove the leftover service
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'kill' && s.current.serviceName === 'old-service',
			),
		).to.have.lengthOf(1);
	});

	it('should not remove an app volumes when they are no longer referenced', async () => {
		const targetApps = createApps({ networks: [DEFAULT_NETWORK] }, true);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
			volumes: [Volume.fromComposeObject('test-volume', 1, {})],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(steps.filter((s) => s.action === 'removeVolume')).to.be.empty;
	});

	it('should remove volumes from previous applications', async () => {
		const targetApps = createApps({ networks: [DEFAULT_NETWORK] }, true);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [],
			// Volume with different id
			volumes: [Volume.fromComposeObject('test-volume', 2, {})],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		expect(steps.filter((s) => s.action === 'removeVolume')).to.not.be.empty;
	});

	it('should infer that we need to create the supervisor network if it does not exist', async () => {
		// stub the networkManager method to fail on finding the supervisor network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(false);

		const targetApps = createApps(
			{ services: [await createService({})], networks: [DEFAULT_NETWORK] },
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
		});

		const [
			ensureNetworkStep,
			...nextSteps
		] = await applicationManager.inferNextSteps(currentApps, targetApps, {
			downloading,
			availableImages,
			containerIdsByAppId,
		});
		expect(ensureNetworkStep).to.deep.include({
			action: 'ensureSupervisorNetwork',
		});
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('should kill a service which depends on the supervisor network, if we need to create the network', async () => {
		// stub the networkManager method to fail on finding the supervisor network
		(networkManager.supervisorNetworkReady as sinon.SinonStub).resolves(false);

		const labels = { 'io.balena.features.supervisor-api': 'true' };

		const targetApps = createApps(
			{
				services: [
					await createService({ labels }, { options: { listenPort: '48484' } }),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService({ labels }, { options: { listenPort: '48484' } }),
			],
			networks: [DEFAULT_NETWORK],
		});

		const [killStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(killStep).to.have.property('action').that.equals('kill');
		expect(killStep)
			.to.have.property('current')
			.that.deep.includes({ serviceName: 'main' });
	});

	it('should infer a cleanup step when a cleanup is required', async () => {
		// Stub the image manager function
		(imageManager.isCleanupNeeded as sinon.SinonStub).resolves(true);

		const targetApps = createApps(
			{
				services: [await createService()],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [await createService()],
			networks: [DEFAULT_NETWORK],
		});

		const [cleanupStep, ...nextSteps] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Cleanup needs to happen first
		expect(cleanupStep).to.deep.include({
			action: 'cleanup',
		});
		expect(nextSteps).to.have.lengthOf(0);
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only target)', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has a matching image already
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
			images: [
				// An image for a service that no longer exists
				{
					name: 'old-image',
					appId: 5,
					serviceId: 5,
					serviceName: 'old-service',
					imageId: 5,
					dependent: 0,
					releaseId: 5,
					dockerImageId: 'sha256:aaaa',
				},
				{
					name: 'main-image',
					appId: 1,
					serviceId: 1,
					serviceName: 'main',
					imageId: 1,
					dependent: 0,
					releaseId: 1,
					dockerImageId: 'sha256:bbbb',
				},
			],
		});

		const [removeImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(removeImageStep)
			.to.have.property('action')
			.that.equals('removeImage');
		expect(removeImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'old-image' });
	});

	it('should infer that an image should be removed if it is no longer referenced in current or target state (only current)', async () => {
		const targetApps = createApps(
			{
				services: [],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [
				await createService(
					{ image: 'main-image' },
					// Target has a matching image already
					{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
				),
			],
			networks: [DEFAULT_NETWORK],
			images: [
				// An image for a service that no longer exists
				{
					name: 'old-image',
					appId: 5,
					serviceId: 5,
					serviceName: 'old-service',
					imageId: 5,
					dependent: 0,
					releaseId: 5,
					dockerImageId: 'sha256:aaaa',
				},
				{
					name: 'main-image',
					appId: 1,
					serviceId: 1,
					serviceName: 'main',
					imageId: 1,
					dependent: 0,
					releaseId: 1,
					dockerImageId: 'sha256:bbbb',
				},
			],
		});

		const [removeImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(removeImageStep)
			.to.have.property('action')
			.that.equals('removeImage');
		expect(removeImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'old-image' });
	});

	it('should infer that an image should be saved if it is not in the available image list but it can be found on disk', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ image: 'main-image' },
						// Target has image info
						{ options: { imageInfo: { Id: 'sha256:bbbb' } } },
					),
				],
				networks: [DEFAULT_NETWORK],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [DEFAULT_NETWORK],
			images: [], // no available images exist
		});

		const [saveImageStep] = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// A start step shoud happen for the depended service first
		expect(saveImageStep).to.have.property('action').that.equals('saveImage');
		expect(saveImageStep)
			.to.have.property('image')
			.that.deep.includes({ name: 'main-image' });
	});

	it('should correctly generate steps for multiple apps', async () => {
		const targetApps = createApps(
			{
				services: [
					await createService(
						{ running: true, image: 'main-image-1' },
						{ appId: 1, serviceId: 1, imageId: 1 },
					),
					await createService(
						{ running: true, image: 'main-image-2' },
						{ appId: 2, serviceId: 2, imageId: 2 },
					),
				],
				networks: [
					// Default networks for two apps
					Network.fromComposeObject('default', 1, {}),
					Network.fromComposeObject('default', 2, {}),
				],
			},
			true,
		);
		const {
			currentApps,
			availableImages,
			downloading,
			containerIdsByAppId,
		} = createCurrentState({
			services: [],
			networks: [
				// Default networks for two apps
				Network.fromComposeObject('default', 1, {}),
				Network.fromComposeObject('default', 2, {}),
			],
			images: [
				{
					name: 'main-image-1',
					appId: 1,
					serviceId: 1,
					serviceName: 'main',
					imageId: 1,
					dependent: 0,
					releaseId: 1,
				},
				{
					name: 'main-image-2',
					appId: 2,
					serviceId: 2,
					serviceName: 'main',
					imageId: 2,
					dependent: 0,
					releaseId: 1,
				},
			],
		});

		const steps = await applicationManager.inferNextSteps(
			currentApps,
			targetApps,
			{
				downloading,
				availableImages,
				containerIdsByAppId,
			},
		);

		// Expect a start step for both apps
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'start' &&
					s.target.appId === 1 &&
					s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);
		expect(
			steps.filter(
				(s: any) =>
					s.action === 'start' &&
					s.target.appId === 2 &&
					s.target.serviceName === 'main',
			),
		).to.have.lengthOf(1);
	});
});
