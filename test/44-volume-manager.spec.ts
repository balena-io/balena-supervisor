import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { VolumeInspectInfo } from 'dockerode';

import * as mockedDockerode from './lib/mocked-dockerode';
import * as volumeManager from '../src/compose/volume-manager';
import log from '../src/lib/supervisor-console';
import Volume from '../src/compose/volume';

describe('Volume Manager', () => {
	let logDebug: SinonStub;
	before(() => {
		logDebug = stub(log, 'debug');
	});
	after(() => {
		logDebug.restore();
	});

	afterEach(() => {
		// Clear Dockerode actions recorded for each test
		mockedDockerode.resetHistory();
		logDebug.reset();
	});

	it('gets all supervised Volumes', async () => {
		// Setup volume data
		const volumeData = [
			createVolumeInspectInfo(Volume.generateDockerName(1, 'redis'), {
				'io.balena.supervised': '1', // Recently created volumes contain io.balena.supervised label
			}),
			createVolumeInspectInfo(Volume.generateDockerName(1, 'mysql'), {
				'io.balena.supervised': '1', // Recently created volumes contain io.balena.supervised label
				'io.balena.app-uuid': 'deadc0de', // More recently created volumes will have an app-uuid label
			}),
			createVolumeInspectInfo(Volume.generateDockerName(1, 'backend')), // Old Volumes will not have labels
			createVolumeInspectInfo('user_created_volume'), // Volume not created by the Supervisor
			createVolumeInspectInfo('decoy', { 'io.balena.supervised': '1' }), // Added decoy to really test the inference (should not return)
		];
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			await expect(volumeManager.getAll()).to.eventually.deep.equal([
				{
					appId: 1,
					uuid: undefined,
					config: {
						driver: 'local',
						driverOpts: {},
						labels: {
							'io.balena.supervised': '1',
						},
					},
					name: 'redis',
				},
				{
					appId: 1,
					uuid: 'deadc0de',
					config: {
						driver: 'local',
						driverOpts: {},
						labels: {
							'io.balena.supervised': '1',
							'io.balena.app-uuid': 'deadc0de',
						},
					},
					name: 'mysql',
				},
				{
					appId: 1,
					uuid: undefined,
					config: {
						driver: 'local',
						driverOpts: {},
						labels: {},
					},
					name: 'backend',
				},
			]);
			// Check that debug message was logged saying we found a Volume not created by us
			expect(logDebug.lastCall.lastArg).to.equal(
				'Found unmanaged Volume: decoy',
			);
		});
	});

	it('can parse null Volumes', async () => {
		// Setup volume data
		// @ts-ignore
		const volumeData: VolumeInspectInfo[] = null;
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			await expect(volumeManager.getAll()).to.eventually.deep.equal([]);
		});
	});

	it('gets a Volume for an application', async () => {
		// Setup volume data
		const volumeData = [
			createVolumeInspectInfo(Volume.generateDockerName(111, 'app'), {
				'io.balena.supervised': '1',
				'io.balena.app-uuid': 'deadc0de',
			}),
			createVolumeInspectInfo(Volume.generateDockerName(222, 'otherApp'), {
				'io.balena.supervised': '1',
				'io.balena.app-uuid': 'deadbeef',
			}),
		];
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			await expect(volumeManager.getAllByAppId(111)).to.eventually.deep.equal([
				{
					appId: 111,
					uuid: 'deadc0de',
					config: {
						driver: 'local',
						driverOpts: {},
						labels: {
							'io.balena.supervised': '1',
							'io.balena.app-uuid': 'deadc0de',
						},
					},
					name: 'app',
				},
			]);
		});
	});

	it('creates a Volume', async () => {
		// Setup volume data
		const volumeData: Dictionary<any> = [];
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			// Volume to create
			const volume = Volume.fromComposeObject('main', 111, 'deadc0de', {});
			stub(volume, 'create');
			// Create volume
			await volumeManager.create(volume);
			// Check volume was created
			expect(volume.create as SinonStub).to.be.calledOnce;
		});
	});

	it('does not try to create a volume that already exists', async () => {
		// Setup volume data
		const volumeData = [
			createVolumeInspectInfo(Volume.generateDockerName(111, 'main'), {
				'io.balena.supervised': '1',
			}),
		];
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			// Volume to try again create
			const volume = Volume.fromComposeObject('main', 111, 'deadc0de', {});
			stub(volume, 'create');
			// Create volume
			await expect(volumeManager.create(volume)).to.be.rejected;
			// Check volume was not created
			expect(volume.create as SinonStub).to.not.be.called;
		});
	});

	it('removes a Volume', async () => {
		// Setup volume data
		const volumeData = [
			createVolumeInspectInfo(Volume.generateDockerName(111, 'main'), {
				'io.balena.supervised': '1',
			}),
		];
		// Perform test
		await mockedDockerode.testWithData({ volumes: volumeData }, async () => {
			// Volume to remove
			const volume = Volume.fromComposeObject('main', 111, 'deadc0de', {});
			stub(volume, 'remove');
			// Remove volume
			await volumeManager.remove(volume);
			// Check volume was removed
			expect(volume.remove as SinonStub).to.be.calledOnce;
		});
	});
});

function createVolumeInspectInfo(
	name: string,
	labels: { [key: string]: string } = {},
	driver: string = 'local',
	options: { [key: string]: string } | null = null,
) {
	return {
		Name: name,
		Driver: driver,
		Labels: labels,
		Options: options,
	};
}
