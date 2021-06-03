import * as _ from 'lodash';
import { expect } from 'chai';

import * as appMock from './lib/application-state-mock';
import { createApp, createService } from './lib/compose-helpers';

import * as applicationManager from '../src/compose/application-manager';
import * as deviceState from '../src/device-state';
import * as config from '../src/config';
import * as dbFormat from '../src/device-state/db-format';

import Service from '../src/compose/service';
import Network from '../src/compose/network';
import Volume from '../src/compose/volume';
import {
	CompositionStep,
	CompositionStepAction,
} from '../src/compose/composition-steps';
import { Image } from '../src/compose/images';
import { inspect } from 'util';

const defaultContext = {
	localMode: false,
	availableImages: [],
	containerIds: {},
	downloading: [],
};

type ServicePredicate = string | ((service: Partial<Service>) => boolean);
type StepTest = Chai.Assertion & {
	asStep?: CompositionStep;
	forCurrent: (predicate: ServicePredicate) => Chai.Assertion;
	forTarget: (predicate: ServicePredicate) => Chai.Assertion;
};

// tslint:disable: no-unused-expression-chai
function withSteps(steps: CompositionStep[]) {
	return {
		expectStep: (action: CompositionStepAction): StepTest => {
			const matchingSteps = _.filter(steps, (step) => step.action === action);

			const assertion: Partial<StepTest> = expect(
				matchingSteps,
				`Step for '${action}', not found`,
			);

			const forService = (
				predicate: ServicePredicate,
				property: 'current' | 'target',
			) => {
				const [firstMatch] = _.filter(matchingSteps, (s) => {
					const t = (s as any)[property];
					if (!t) {
						throw new Error(`${property} is not defined for action ${action}`);
					}

					if (_.isFunction(predicate)) {
						return predicate(t);
					} else {
						return t.serviceName! === predicate;
					}
				});
				return expect(
					firstMatch,
					`Step for '${action}' matching predicate, not found`,
				);
			};

			assertion.asStep = matchingSteps[0];
			assertion.forCurrent = (service) => forService(service, 'current');
			assertion.forTarget = (service) => forService(service, 'target');

			return assertion as StepTest;
		},
		rejectStep: (action: CompositionStepAction) => expectNoStep(action, steps),
	};
}

function expectStep(
	action: CompositionStepAction,
	steps: CompositionStep[],
): number {
	const idx = _.findIndex(steps, { action });
	if (idx === -1) {
		console.log(inspect({ action, steps }, true, 3, true));
		throw new Error(`Expected to find step with action: ${action}`);
	}
	return idx;
}

function expectNoStep(action: CompositionStepAction, steps: CompositionStep[]) {
	if (_.some(steps, { action })) {
		console.log(inspect({ action, steps }, true, 3, true));
		throw new Error(`Did not expect to find step with action: ${action}`);
	}
}

const defaultNetwork = Network.fromComposeObject('default', 1, 'test-uuid', {});

describe('compose/app', () => {
	before(async () => {
		await config.initialized;
		await applicationManager.initialized;
	});
	beforeEach(() => {
		// Sane defaults
		appMock.mockSupervisorNetwork(true);
		appMock.mockManagers([], [], []);
		appMock.mockImages([], false, []);
	});
	afterEach(() => {
		appMock.unmockAll();
	});

	it('should correctly infer a volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, 'test-uuid', {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
	});

	it('should correctly infer more than one volume create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, 'test-uuid', {}),
				Volume.fromComposeObject('test-volume-2', 1, 'test-uuid', {}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume');
		delete steps[idx];
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-volume-2');
	});

	// We don't remove volumes until the end
	it('should correctly not infer a volume remove step when the app is still referenced', () => {
		const current = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, 'test-uuid', {}),
				Volume.fromComposeObject('test-volume-2', 1, 'test-uuid', {}),
			],
			false,
		);
		const target = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume-2', 1, 'test-uuid', {})],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		expect(() => {
			expectStep('removeVolume', steps);
		}).to.throw();
	});

	it('should correctly infer volume recreation steps', () => {
		const current = createApp(
			[],
			[],
			[Volume.fromComposeObject('test-volume', 1, 'test-uuid', {})],
			false,
		);
		const target = createApp(
			[],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, 'test-uuid', {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);

		let idx = expectStep('removeVolume', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({
				'io.balena.supervised': 'true',
				'io.balena.app-uuid': 'test-uuid',
			});

		current.volumes = {};
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createVolume', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('config')
			.that.has.property('labels')
			.that.deep.equals({
				'io.balena.supervised': 'true',
				'io.balena.app-uuid': 'test-uuid',
				test: 'test',
			});
	});

	it('should kill dependencies of a volume before changing config', async () => {
		const current = createApp(
			[await createService({ volumes: ['test-volume'] })],
			[],
			[Volume.fromComposeObject('test-volume', 1, 'test-uuid', {})],
			false,
		);
		const target = createApp(
			[await createService({ volumes: ['test-volume'] })],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, 'test-uuid', {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);

		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should correctly infer to remove an apps volumes when it is no longer referenced', async () => {
		appMock.mockManagers(
			[],
			[Volume.fromComposeObject('test-volume', 1, 'test-uuid', {})],
			[],
		);
		appMock.mockImages([], false, []);

		const origFn = dbFormat.getApps;
		// @ts-expect-error Assigning to a RO property
		dbFormat.getApps = () => Promise.resolve({});
		const target = await deviceState.getTarget();

		try {
			const steps = await applicationManager.getRequiredSteps(
				target.local.apps,
			);
			expect(steps).to.have.length(1);
			expect(steps[0]).to.have.property('action').that.equals('removeVolume');
		} finally {
			// @ts-expect-error Assigning to a RO property
			dbFormat.getApps = origFn;
		}
	});

	it('should correctly infer a network create step', () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[],
			[Network.fromComposeObject('default', 1, 'test-uuid', {})],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('createNetwork', steps);
	});

	it('should correctly infer a network remove step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			false,
		);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should correctly infer a network recreation step', () => {
		const current = createApp(
			[],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			false,
		);
		const target = createApp(
			[],
			[
				Network.fromComposeObject('test-network', 1, 'test-uuid', {
					labels: { TEST: 'TEST' },
				}),
			],
			[],
			true,
		);

		let steps = current.nextStepsForAppUpdate(defaultContext, target);
		let idx = expectStep('removeNetwork', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('name')
			.that.equals('test-network');

		delete current.networks['test-network'];
		steps = current.nextStepsForAppUpdate(defaultContext, target);
		idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('test-network');
	});

	it('should kill dependencies of networks before removing', async () => {
		const current = createApp(
			[await createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			false,
		);
		const target = createApp([await createService({})], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
	});

	it('should kill dependencies of networks before changing config', async () => {
		const current = createApp(
			[await createService({ networks: { 'test-network': {} } })],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			false,
		);
		const target = createApp(
			[await createService({ networks: { 'test-network': {} } })],
			[
				Network.fromComposeObject('test-network', 1, 'test-uuid', {
					labels: { test: 'test' },
				}),
			],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('test');
		// We shouldn't try to remove the network until we have gotten rid of the dependencies
		expect(() => expectStep('removeNetwork', steps)).to.throw();
	});

	it('should not output a kill step for a service which is already stopping when changing a volume', async () => {
		const service = await createService({ volumes: ['test-volume'] });
		service.status = 'Stopping';
		const current = createApp(
			[service],
			[],
			[Volume.fromComposeObject('test-volume', 1, 'test-uuid', {})],
			false,
		);
		const target = createApp(
			[service],
			[],
			[
				Volume.fromComposeObject('test-volume', 1, 'test-uuid', {
					labels: { test: 'test' },
				}),
			],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expect(() => expectStep('kill', steps)).to.throw();
	});

	it('should create the default network if it does not exist', () => {
		const current = createApp([], [], [], false);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('createNetwork', steps);
		expect(steps[idx])
			.to.have.property('target')
			.that.has.property('name')
			.that.equals('default');
	});

	it('should create a kill step for service which is no longer referenced', async () => {
		const current = createApp(
			[
				await createService({}, 1, 'main', 1, 1),
				await createService({}, 1, 'aux', 1, 2),
			],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			false,
		);
		const target = createApp(
			[await createService({}, 1, 'main', 2, 1)],
			[Network.fromComposeObject('test-network', 1, 'test-uuid', {})],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		const idx = expectStep('kill', steps);
		expect(steps[idx])
			.to.have.property('current')
			.that.has.property('serviceName')
			.that.equals('aux');
	});

	it('should emit a noop when a service which is no longer referenced is already stopping', async () => {
		const current = createApp(
			[
				await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {
					status: 'Stopping',
				}),
			],
			[],
			[],
			false,
		);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('noop', steps);
	});

	it('should remove a dead container that is still referenced in the target state', async () => {
		const current = createApp(
			[
				await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {
					status: 'Dead',
				}),
			],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('remove', steps);
	});

	it('should remove a dead container that is not referenced in the target state', async () => {
		const current = createApp(
			[
				await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {
					status: 'Dead',
				}),
			],
			[],
			[],
			false,
		);
		const target = createApp([], [], [], true);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('remove', steps);
	});

	it('should emit a noop when a service has an image downloading', async () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(
			{ ...defaultContext, ...{ downloading: [1] } },
			target,
		);
		expectStep('noop', steps);
	});

	it('should emit an updateMetadata step when a service has not changed but the release has', async () => {
		const current = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({}, 1, 'main', 2, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('updateMetadata', steps);
	});

	it('should stop a container which has stoppped as its target', async () => {
		const current = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({ running: false }, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		expectStep('stop', steps);
	});

	it('should not try to start a container which has exitted and has restart policy of no', async () => {
		// Container is a "run once" type of service so it has exitted.
		const current = createApp(
			[
				await createService(
					{ restart: 'no', running: false },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{ containerId: 'run_once' },
				),
			],
			[],
			[],
			false,
		);

		// Mark this container as previously being started
		applicationManager.containerStarted['run_once'] = true;

		// Now test that another start step is not added on this service
		const target = createApp(
			[
				await createService(
					{ restart: 'no', running: true },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{ containerId: 'run_once' },
				),
			],
			[],
			[],
			true,
		);
		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).rejectStep('start');
	});

	it('should recreate a container if the target configuration changes', async () => {
		const contextWithImages = {
			...defaultContext,
			...{
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main',
					},
				],
			},
		};
		let current = createApp(
			[await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {})],
			[defaultNetwork],
			[],
			false,
		);
		const target = createApp(
			[
				await createService(
					{ privileged: true },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			true,
		);

		// should see a 'stop'
		let steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('stop').to.exist;

		// remove the service since it's stopped...
		current = createApp([], [defaultNetwork], [], false);

		// now should see a 'start'
		steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps)
			.expectStep('start')
			.forTarget((t) => t.serviceName === 'main').to.exist;
	});

	it('should not start a container when it depends on a service which is being installed', async () => {
		const mainImage: Image = {
			appId: 1,
			dependent: 0,
			imageId: 1,
			releaseId: 1,
			serviceId: 1,
			name: 'main-image',
			serviceName: 'main',
		};

		const depImage: Image = {
			appId: 1,
			dependent: 0,
			imageId: 2,
			releaseId: 1,
			serviceId: 2,
			name: 'dep-image',
			serviceName: 'dep',
		};

		const availableImages = [mainImage, depImage];
		const contextWithImages = { ...defaultContext, ...{ availableImages } };

		try {
			let current = createApp(
				[
					await createService(
						{ running: false },
						1,
						'dep',
						1,
						2,
						2,
						'test-uuid',
						{
							status: 'Installing',
							containerId: 'id',
						},
					),
				],
				[defaultNetwork],
				[],
				false,
			);
			const target = createApp(
				[
					await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {
						dependsOn: ['dep'],
					}),
					await createService({}, 1, 'dep', 1, 2, 2, 'test-uuid'),
				],
				[defaultNetwork],
				[],
				true,
			);

			let steps = current.nextStepsForAppUpdate(contextWithImages, target);
			withSteps(steps)
				.expectStep('start')
				.forTarget((t) => t.serviceName === 'dep').to.exist;

			withSteps(steps)
				.expectStep('start')
				.forTarget((t) => t.serviceName === 'main').to.not.exist;

			// we now make our current state have the 'dep' service as started...
			current = createApp(
				[
					await createService({}, 1, 'dep', 1, 2, 2, 'test-uuid', {
						containerId: 'id',
					}),
				],
				[defaultNetwork],
				[],
				false,
			);

			// We keep track of the containers that we've tried to start so that we
			// dont spam start requests if the container hasn't started running
			applicationManager.containerStarted['id'] = true;

			// we should now see a start for the 'main' service...
			steps = current.nextStepsForAppUpdate(
				{ ...contextWithImages, ...{ containerIds: { dep: 'id' } } },
				target,
			);
			withSteps(steps)
				.expectStep('start')
				.forTarget((t) => t.serviceName === 'main').to.exist;
		} finally {
			delete applicationManager.containerStarted['id'];
		}
	});

	it('should emit a fetch step when an image has not been downloaded for a service', async () => {
		const current = createApp([], [], [], false);
		const target = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('fetch').to.exist;
	});

	it('should stop a container which has stoppped as its target', async () => {
		const current = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({ running: false }, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('stop');
	});

	it('should create a start step when all that changes is a running state', async () => {
		const contextWithImages = {
			...defaultContext,
			...{
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main',
					},
				],
			},
		};
		const current = createApp(
			[
				await createService(
					{ running: false },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			false,
		);
		const target = createApp(
			[await createService({}, 1, 'main', 1, 1, 1, 'test-uuid', {})],
			[defaultNetwork],
			[],
			true,
		);

		// now should see a 'start'
		const steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps)
			.expectStep('start')
			.forTarget((t) => t.serviceName === 'main').to.exist;
	});

	it('should not infer a fetch step when the download is already in progress', async () => {
		const contextWithDownloading = {
			...defaultContext,
			...{
				downloading: [1],
			},
		};
		const current = createApp([], [], [], false);
		const target = createApp(
			[await createService({}, 1, 'main', 1, 1, 1)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(contextWithDownloading, target);
		withSteps(steps).expectStep('fetch').forTarget('main').to.not.exist;
	});

	it('should create a kill step when a service has to be updated but the strategy is kill-then-download', async () => {
		const contextWithImages = {
			...defaultContext,
			...{
				availableImages: [
					{
						appId: 1,
						dependent: 0,
						imageId: 1,
						releaseId: 1,
						serviceId: 1,
						name: 'main-image',
						serviceName: 'main',
					},
				],
			},
		};

		const labels = {
			'io.balena.update.strategy': 'kill-then-download',
		};

		const current = createApp(
			[
				await createService(
					{ labels, image: 'main-image' },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			false,
		);
		const target = createApp(
			[
				await createService(
					{ labels, image: 'main-image-2' },
					1,
					'main',
					2,
					1,
					2,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			true,
		);

		let steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('kill').forCurrent('main').to.exist;

		// next volatile state...
		const afterKill = createApp([], [defaultNetwork], [], false);

		steps = afterKill.nextStepsForAppUpdate(contextWithImages, target);

		withSteps(steps).expectStep('fetch').to.exist;

		const fetchStep = withSteps(steps).expectStep('fetch').asStep;

		expect(fetchStep)
			.to.have.property('image')
			.that.has.property('name')
			.that.equals('main-image-2');
	});

	it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
		const contextWithImages = {
			...defaultContext,
			...{
				downloading: [4],
				availableImages: [
					{
						appId: 1,
						releaseId: 1,
						dependent: 0,
						name: 'main-image',
						imageId: 1,
						serviceName: 'main',
						serviceId: 1,
					},
					{
						appId: 1,
						releaseId: 1,
						dependent: 0,
						name: 'dep-image',
						imageId: 2,
						serviceName: 'dep',
						serviceId: 2,
					},
					{
						appId: 1,
						releaseId: 2,
						dependent: 0,
						name: 'main-image-2',
						imageId: 3,
						serviceName: 'main',
						serviceId: 1,
					},
				],
			},
		};

		const current = createApp(
			[
				await createService(
					{ image: 'main-image' },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{
						dependsOn: ['dep'],
					},
				),
				await createService(
					{ image: 'dep-image' },
					1,
					'dep',
					1,
					2,
					2,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			false,
		);
		const target = createApp(
			[
				await createService(
					{ image: 'main-image-2' },
					1,
					'main',
					2,
					1,
					3,
					'test-uuid',
					{
						dependsOn: ['dep'],
					},
				),
				await createService(
					{ image: 'dep-image-2' },
					1,
					'dep',
					2,
					2,
					4,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('kill').forCurrent('main').to.not.exist;
	});

	it('should create several kill steps as long as there is no unmet dependencies', async () => {
		const contextWithImages = {
			...defaultContext,
			...{
				availableImages: [
					{
						appId: 1,
						releaseId: 1,
						dependent: 0,
						name: 'main-image',
						imageId: 1,
						serviceName: 'main',
						serviceId: 1,
					},
					{
						appId: 1,
						releaseId: 2,
						dependent: 0,
						name: 'main-image-2',
						imageId: 2,
						serviceName: 'main',
						serviceId: 1,
					},
				],
			},
		};

		const current = createApp(
			[
				await createService(
					{ image: 'main-image' },
					1,
					'main',
					1,
					1,
					1,
					'test-uuid',
					{},
				),
			],
			[defaultNetwork],
			[],
			false,
		);
		const target = createApp(
			[await createService({ image: 'main-image-2' }, 1, 'main', 2, 1, 2)],
			[defaultNetwork],
			[],
			true,
		);

		let steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('kill').forCurrent('main').to.exist;

		// same states again...
		steps = current.nextStepsForAppUpdate(contextWithImages, target);
		withSteps(steps).expectStep('kill').forCurrent('main').to.exist;
	});

	it('should create a kill step when a service has to be updated but the strategy is kill-then-download', async () => {
		const labels = {
			'io.balena.update.strategy': 'kill-then-download',
		};

		const current = createApp([await createService({ labels })], [], [], false);
		const target = createApp(
			[await createService({ privileged: true })],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('kill').forCurrent('main');
	});

	it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
		const current = createApp(
			[await createService({ image: 'image1' })],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({ image: 'image2' })],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('fetch');
		withSteps(steps).rejectStep('kill');
	});

	it('should create several kill steps as long as there is no unmet dependencies', async () => {
		const current = createApp(
			[
				await createService({}, 1, 'one', 1, 2),
				await createService({}, 1, 'two', 1, 3),
				await createService({}, 1, 'three', 1, 4),
			],
			[],
			[],
			false,
		);
		const target = createApp(
			[await createService({}, 1, 'three', 1, 4)],
			[],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('kill').to.have.length(2);
	});

	it('should not create a service when a network it depends on is not ready', async () => {
		const current = createApp([], [defaultNetwork], [], false);
		const target = createApp(
			[await createService({ networks: ['test'] }, 1)],
			[defaultNetwork, Network.fromComposeObject('test', 1, 'test-uuid', {})],
			[],
			true,
		);

		const steps = current.nextStepsForAppUpdate(defaultContext, target);
		withSteps(steps).expectStep('createNetwork');
		withSteps(steps).rejectStep('start');
	}); // no create service, is create network

	describe('Intermediate state apply support', () => {
		beforeEach(() => {
			appMock.mockSupervisorNetwork(true);
			appMock.mockManagers([], [], []);
			appMock.mockImages([], false, []);

			applicationManager.setIsApplyingIntermediate(true);
		});
		afterEach(() => {
			appMock.unmockAll();
			applicationManager.setIsApplyingIntermediate(false);
		});

		it('should generate the correct step sequence for a volume purge request', async () => {
			const service = await createService({
				volumes: ['db-volume'],
				image: 'test-image',
			});
			const volume = Volume.fromComposeObject(
				'db-volume',
				service.appId,
				'deadc0de',
				{},
			);
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: service.appId,
							dependent: 0,
							imageId: service.imageId,
							releaseId: service.releaseId,
							serviceId: service.serviceId,
							name: 'test-image',
							serviceName: service.serviceName,
						} as Image,
					],
				},
			};
			// Temporarily set target services & volumes to empty, as in doPurge
			let intermediateTarget = createApp([], [defaultNetwork], [], true);

			// Generate current with one service & one volume
			const current = createApp([service], [defaultNetwork], [volume], false);

			// Step 1: kill
			let steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			withSteps(steps)
				.expectStep('kill')
				.forCurrent(service.serviceName as ServicePredicate);
			expect(steps).to.have.length(1);

			// Step 2: noop (service is stopping)
			service.status = 'Stopping';
			steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expectStep('noop', steps);
			expect(steps).to.have.length(1);

			// No steps, simulate container removal & explicit volume removal as in doPurge
			current.services = [];
			steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expect(steps).to.have.length(0);
			current.volumes = {};

			// Step 3: start & createVolume
			service.status = 'Running';
			intermediateTarget = createApp(
				[service],
				[defaultNetwork],
				[volume],
				true,
			);
			steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expect(steps).to.have.length(2);
			withSteps(steps)
				.expectStep('start')
				.forTarget(service.serviceName as ServicePredicate);
			expectStep('createVolume', steps);
		});
	});
});
