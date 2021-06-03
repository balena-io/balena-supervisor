import { promises as fs } from 'fs';
import * as mockedDockerode from './lib/mocked-dockerode';
import { expect } from 'chai';
import * as appMock from './lib/application-state-mock';
import { createService } from './lib/compose-helpers';

import * as db from '../src/db';
import * as dbFormat from '../src/device-state/db-format';
import * as deviceState from '../src/device-state';
import * as applicationManager from '../src/compose/application-manager';
import supervisorVersion = require('../src/lib/supervisor-version');
import { intialiseContractRequirements } from '../src/lib/contracts';
import { TargetState } from '../src/types/state';
import Volume from '../src/compose/volume';
import Network from '../src/compose/network';

describe('App UUIDs', () => {
	let uuidTargetState: TargetState;
	let uuidTestUuid: string;
	let uuidTestReleaseVersion: string;
	let uuidTestAppId: number;

	before(async () => {
		uuidTargetState = JSON.parse(
			await fs.readFile(
				require.resolve('./data/uuid-target-state.json'),
				'utf-8',
			),
		);
		uuidTestUuid = Object.keys(uuidTargetState.local.apps)[0];
		uuidTestReleaseVersion =
			uuidTargetState.local.apps[uuidTestUuid].releaseVersion;
		uuidTestAppId = uuidTargetState.local.apps[uuidTestUuid].appId;

		mockedDockerode.registerOverride('getImage', () => {
			return {
				inspect: async () => {
					/* noop */
				},
			} as any;
		});

		await db.initialized;
		await applicationManager.initialized;
		intialiseContractRequirements({
			supervisorVersion,
			deviceType: 'intel-nuc',
			l4tVersion: '32.2',
		});
	});

	describe('Target state', () => {
		before(async () => {
			await db.models('app').del();
		});
		it('should correctly validate apps keyed by UUID', async () => {
			// Reject v2 target states
			await expect(
				deviceState.setTarget({
					local: {
						name: 'some-name',
						config: {},
						apps: {
							'1': {
								name: 'pi4test',
								commit: 'c23e5a0f49d31ea8ca2a4866e1ba8482',
								releaseId: 1551563,
								services: {},
								volumes: {},
								networks: {},
							},
						},
					},
				} as any),
			).to.be.rejected;
			await expect(deviceState.setTarget(uuidTargetState)).to.not.be.rejected;
		});

		it('should correctly set the UUID and appId in the database', async () => {
			await deviceState.setTarget(uuidTargetState);
			const apps = await db.models('app').select();

			expect(apps).to.have.length(1);
			expect(apps[0]).to.have.property('uuid').that.equals(uuidTestUuid);
			expect(apps[0])
				.to.have.property('releaseVersion')
				.that.equals(uuidTestReleaseVersion);
			expect(apps[0]).to.have.property('appId').that.equals(uuidTestAppId);
		});

		it('should correctly build an app with a UUID, appId and type from target state', async () => {
			await deviceState.setTarget(uuidTargetState);

			const apps = Object.values(await dbFormat.getApps());
			expect(apps).to.have.length(1);
			expect(apps[0]).to.have.property('uuid').that.equals(uuidTestUuid);
		});

		it('should generate a container config with a UUID', async () => {
			const service = await createService(
				{},
				123,
				'test',
				123,
				123,
				123,
				'test-uuid',
			);
			expect(service.toDockerContainer({} as any))
				.that.has.property('Labels')
				.that.has.property('io.balena.app-uuid')
				.that.equals('test-uuid');
		});

		it('should generate a volume config with a UUID', () => {
			const volume = Volume.fromComposeObject('test', 123, 'test-uuid', {});

			expect(volume.toDockerVolume())
				.to.have.property('Labels')
				.that.has.property('io.balena.app-uuid')
				.that.equals('test-uuid');
		});

		it('should generate a network config with a UUID', () => {
			const network = Network.fromComposeObject('test', 1234, 'test-uuid', {});

			expect(network.toDockerConfig())
				.to.have.property('Labels')
				.that.has.property('io.balena.app-uuid')
				.that.equals('test-uuid');
		});
	});

	describe('Current state', () => {
		it('should group components by uuid if possible', async () => {
			appMock.mockManagers(
				[
					await createService({}, 1234, 'test', 1234, 1234, 1234, 'test-uuid'),
					await createService({}, 2345, 'test', 1234, 1234, 1234, 'test-uuid'),
				],
				[],
				[],
			);

			expect(
				Object.keys(await applicationManager.getCurrentApps()),
			).to.have.length(1);

			appMock.mockManagers(
				[],
				[
					Volume.fromComposeObject('test', 123, 'test-uuid', {}),
					Volume.fromComposeObject('test2', 124, 'test-uuid', {}),
				],
				[],
			);

			expect(
				Object.keys(await applicationManager.getCurrentApps()),
			).to.have.length(1);

			appMock.mockManagers(
				[],
				[],
				[
					Network.fromComposeObject('test', 123, 'test-uuid', {}),
					Network.fromComposeObject('test2', 256, 'test-uuid', {}),
				],
			);
			expect(
				Object.keys(await applicationManager.getCurrentApps()),
			).to.have.length(1);

			appMock.mockManagers(
				[await createService({}, 1234, 'test', 1234, 1234, 1234, 'test-uuid')],
				[Volume.fromComposeObject('test', 234, 'test-uuid', {})],
				[Network.fromComposeObject('test2', 256, 'test-uuid', {})],
			);
			expect(
				Object.keys(await applicationManager.getCurrentApps()),
			).to.have.length(1);
		});

		it('should fall back to grouping by appId when no uuid is present', async () => {
			appMock.mockManagers(
				[await createService({}, 1234, 'test', 1234, 1234, 1234)],
				[Volume.fromComposeObject('test', 1234, 'test-uuid', {})],
				[Network.fromComposeObject('test2', 1234, 'test-uuid', {})],
			);

			expect(Object.keys(await applicationManager.getCurrentApps()));
		});

		it('should populate a UUID in an app', async () => {
			appMock.unmockAll();
			mockedDockerode.registerOverride('listContainers', async () => {
				return [
					{
						Id: 'container1',
						Labels: {
							'io.balena.app-id': '1623449',
							'io.balena.supervised': 'true',
							'io.balena.service-name': 'main',
							'io.balena.service-id': '482141',
							'io.balena.app-uuid': uuidTestUuid,
						},
					},
				] as any;
			});
			mockedDockerode.registerOverride('getContainer', ((_name: string) => {
				return {
					inspect: async () => ({
						State: {
							Running: true,
						},
						Name: 'main_482141_1623449',
						HostConfig: {},
						Config: {
							Labels: {
								'io.balena.app-id': '1623449',
								'io.balena.supervised': 'true',
								'io.balena.service-name': 'main',
								'io.balena.service-id': '482141',
								'io.balena.app-uuid': uuidTestUuid,
							},
							Hostname: 'test',
						},
					}),
				};
			}) as any);

			const currentState = await deviceState.getCurrentState();
			const apps = Object.values(currentState.local.apps);
			expect(apps).to.have.length(1);
			expect(apps[0]).to.have.property('uuid').that.equals(uuidTestUuid);

			mockedDockerode.restoreOverride('listContainers');
			mockedDockerode.restoreOverride('getContainer');
		});
	});
});
