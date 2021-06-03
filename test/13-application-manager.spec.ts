import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { stub } from 'sinon';
import { expect } from 'chai';

import Network from '../src/compose/network';

import Service from '../src/compose/service';
import Volume from '../src/compose/volume';
import * as deviceState from '../src/device-state';
import * as dockerUtils from '../src/lib/docker-utils';
import * as images from '../src/compose/images';

import prepare = require('./lib/prepare');
import * as db from '../src/db';
import * as dbFormat from '../src/device-state/db-format';
import * as targetStateCache from '../src/device-state/target-state-cache';
import * as config from '../src/config';
import { TargetApplication, TargetApplications } from '../src/types/state';

import * as applicationManager from '../src/compose/application-manager';

let availableImages: any[] | null;
let targetState: any[] | null;

const dependentStateFormat = {
	appId: 1234,
	image: 'foo/bar',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: { RESIN_FOO: 'var' },
	environment: { FOO: 'var2' },
	parentApp: 256,
	imageId: 45,
};

const dependentStateFormatNormalised = {
	appId: 1234,
	image: 'foo/bar:latest',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: { RESIN_FOO: 'var' },
	environment: { FOO: 'var2' },
	parentApp: 256,
	imageId: 45,
};

let currentState = (targetState = availableImages = null);

const dependentDBFormat = {
	appId: 1234,
	image: 'foo/bar:latest',
	commit: 'bar',
	releaseId: 3,
	name: 'app',
	config: JSON.stringify({ RESIN_FOO: 'var' }),
	environment: JSON.stringify({ FOO: 'var2' }),
	parentApp: 256,
	imageId: 45,
};

describe.skip('ApplicationManager', function () {
	const originalInspectByName = images.inspectByName;
	before(async function () {
		await prepare();
		await deviceState.initialized;

		this.applications = applicationManager;

		// @ts-expect-error assigning to a RO property
		images.inspectByName = () =>
			Promise.resolve({
				Config: {
					Cmd: ['someCommand'],
					Entrypoint: ['theEntrypoint'],
					Env: [],
					Labels: {},
					Volumes: [],
				},
			});

		stub(dockerUtils, 'getNetworkGateway').returns(
			Bluebird.Promise.resolve('172.17.0.1'),
		);
		stub(dockerUtils.docker, 'listContainers').returns(
			Bluebird.Promise.resolve([]),
		);
		stub(dockerUtils.docker, 'listImages').returns(
			Bluebird.Promise.resolve([]),
		);
		stub(Service as any, 'extendEnvVars').callsFake(function (env) {
			env['ADDITIONAL_ENV_VAR'] = 'foo';
			return env;
		});

		this.normaliseCurrent = async function (current: {
			local: { apps: Dictionary<TargetApplication> };
		}) {
			const currentCloned: any = _.cloneDeep(current);
			currentCloned.local.apps = {};

			_.each(current.local.apps, (app, appId) => {
				const appCloned = {
					...app,
					services: _.mapValues(app.services, (svc) =>
						// @ts-ignore
						Service.fromComposeObject(svc, { appName: 'test' }),
					),
					networks: _.mapValues(app.networks, (conf, name) =>
						Network.fromComposeObject(
							name,
							parseInt(appId, 10),
							'test-uuid',
							conf,
						),
					),
					volumes: _.mapValues(app.volumes, (conf, name) =>
						Volume.fromComposeObject(
							name,
							parseInt(appId, 10),
							'test-uuid',
							conf,
						),
					),
				};
				currentCloned.local.apps[parseInt(appId, 10)] = appCloned;
			});
			return currentCloned;
		};

		this.normaliseTarget = async (
			target: {
				local: { apps: TargetApplications };
			},
			available: any,
		) => {
			const source = await config.get('apiEndpoint');
			const cloned: any = _.cloneDeep(target);

			// @ts-ignore types don't quite match up
			await dbFormat.setApps(target.local.apps, source);

			cloned.local.apps = await dbFormat.getApps();

			// We mock what createTargetService does when an image is available
			_.each(cloned.local.apps, (app) => {
				_.each(app.services, (svc) => {
					const img = _.find(available, (i) => i.name === svc.config.image);
					if (img != null) {
						svc.config.image = img.dockerImageId;
					}
				});
			});
			return cloned;
		};
	});

	beforeEach(async () => {
		({
			currentState,
			targetState,
			availableImages,
		} = require('./lib/application-manager-test-states'));
		await db.models('app').del();
		// @ts-expect-error modification of a RO property
		targetStateCache.targetState = undefined;
	});

	after(async function () {
		// @ts-expect-error Assigning to a RO property
		images.inspectByName = originalInspectByName;
		// @ts-expect-error restore on non-stubbed type
		dockerUtils.getNetworkGateway.restore();
		// @ts-expect-error restore on non-stubbed type
		dockerUtils.docker.listContainers.restore();
		// @ts-expect-error restore on non-stubbed type
		dockerUtils.docker.listImages.restore();
		// @ts-expect-error use of private function
		Service.extendEnvVars.restore();

		await db.models('app').del();
		// @ts-expect-error modification of a RO property
		targetStateCache.targetState = undefined;
	});

	it('should init', async () => {
		await applicationManager.initialized;
	});

	it('infers a start step when all that changes is a running state', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[0], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'start',
						current: current.local.apps['1234'].services[24],
						target: target.local.apps['1234'].services[24],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers a kill step when a service has to be removed', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[1], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[24],
						target: undefined,
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers a fetch step when a service has to be updated', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[2], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'fetch',
						image: this.applications.imageForService(
							target.local.apps['1234'].services[24],
						),
						serviceId: 24,
						appId: 1234,
						serviceName: 'anotherService',
					},
				]);
			},
		);
	});

	it('does not infer a fetch step when the download is already in progress', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[2], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[target.local.apps['1234'].services[24].imageId],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{ action: 'noop', appId: 1234 },
				]);
			},
		);
	});

	it('infers a kill step when a service has to be updated but the strategy is kill-then-download', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[3], availableImages[0]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[0],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.deep.equal([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[24],
						target: target.local.apps['1234'].services[24],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('does not infer to kill a service with default strategy if a dependency is not downloaded', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[4]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[2]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[2],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'fetch',
						image: this.applications.imageForService(
							target.local.apps['1234'].services[23],
						),
						serviceId: 23,
						appId: 1234,
						serviceName: 'aservice',
					},
					{ action: 'noop', appId: 1234 },
				]);
			},
		);
	});

	it('infers to kill several services as long as there is no unmet dependency', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[0]),
			// @ts-ignore
			this.normaliseTarget(targetState[5], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[23],
						target: target.local.apps['1234'].services[23],
						serviceId: 23,
						appId: 1234,
						options: {},
					},
					{
						action: 'kill',
						current: current.local.apps['1234'].services[24],
						target: target.local.apps['1234'].services[24],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to start the dependency first', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[1]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[23],
						serviceId: 23,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to start a service once its dependency has been met', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[2]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[24],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('infers to remove spurious containers', function () {
		return Bluebird.Promise.join(
			// @ts-ignore
			this.normaliseCurrent(currentState[3]),
			// @ts-ignore
			this.normaliseTarget(targetState[4], availableImages[1]),
			(current, target) => {
				const steps = this.applications._inferNextSteps(
					false,
					// @ts-ignore
					availableImages[1],
					[],
					true,
					current,
					target,
					false,
					{},
					{},
				);
				return expect(steps).to.eventually.have.deep.members([
					{
						action: 'kill',
						current: current.local.apps['1234'].services[23],
						target: undefined,
						serviceId: 23,
						appId: 1234,
						options: {},
					},
					{
						action: 'start',
						current: null,
						target: target.local.apps['1234'].services[24],
						serviceId: 24,
						appId: 1234,
						options: {},
					},
				]);
			},
		);
	});

	it('converts a dependent app from a state format to a db format, normalising the image name', function () {
		const app = this.applications.proxyvisor.normaliseDependentAppForDB(
			dependentStateFormat,
		);
		return expect(app).to.eventually.deep.equal(dependentDBFormat);
	});

	it('converts a dependent app in DB format into state format', function () {
		const app = this.applications.proxyvisor.normaliseDependentAppFromDB(
			dependentDBFormat,
		);
		return expect(app).to.eventually.deep.equal(dependentStateFormatNormalised);
	});

	return describe('Volumes', function () {
		before(function () {
			return stub(this.applications, 'removeAllVolumesForApp').returns(
				Bluebird.Promise.resolve([
					{
						action: 'removeVolume',
						current: Volume.fromComposeObject('my_volume', 12, 'test-uuid', {}),
					},
				]),
			);
		});

		after(function () {
			return this.applications.removeAllVolumesForApp.restore();
		});

		it('should not remove volumes when they are no longer referenced', function () {
			return Bluebird.Promise.join(
				// @ts-ignore
				this.normaliseCurrent(currentState[6]),
				// @ts-ignore
				this.normaliseTarget(targetState[0], availableImages[0]),
				(current, target) => {
					return this.applications
						._inferNextSteps(
							false,
							// @ts-ignore
							availableImages[0],
							[],
							true,
							current,
							target,
							false,
							{},
							{},
						)
						.then(
							// @ts-ignore
							(steps) =>
								expect(
									_.every(steps, (s) => s.action !== 'removeVolume'),
									'Volumes from current app should not be removed',
								).to.be.true,
						);
				},
			);
		});

		it('should remove volumes from previous applications', function () {
			return Bluebird.Promise.join(
				// @ts-ignore
				this.normaliseCurrent(currentState[5]),
				// @ts-ignore
				this.normaliseTarget(targetState[6], []),
				(current, target) => {
					return (
						this.applications
							._inferNextSteps(
								false,
								[],
								[],
								true,
								current,
								target,
								false,
								{},
								{},
							)
							// tslint:disable-next-line
							.then(function (steps: { current: any }[]) {
								expect(steps).to.have.length(1);
								expect(steps[0])
									.to.have.property('action')
									.that.equals('removeVolume');
								return expect(steps[0].current)
									.to.have.property('appId')
									.that.equals(12);
							})
					);
				},
			);
		});
	});
});
