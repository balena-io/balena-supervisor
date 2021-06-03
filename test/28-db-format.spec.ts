import { expect } from 'chai';
import * as _ from 'lodash';

import prepare = require('./lib/prepare');
import * as config from '../src/config';
import * as dbFormat from '../src/device-state/db-format';
import * as targetStateCache from '../src/device-state/target-state-cache';
import * as images from '../src/compose/images';

import App from '../src/compose/app';
import Service from '../src/compose/service';
import Network from '../src/compose/network';
import { TargetApplication } from '../src/types/state';

function getDefaultNetworks(appId: number, uuid: string) {
	return {
		default: Network.fromComposeObject('default', appId, uuid, {}),
	};
}

describe('DB Format', () => {
	const originalInspect = images.inspectByName;
	let apiEndpoint: string;
	before(async () => {
		await prepare();
		await config.initialized;
		await targetStateCache.initialized;

		apiEndpoint = await config.get('apiEndpoint');

		// Setup some mocks
		// @ts-expect-error Assigning to a RO property
		images.inspectByName = () => {
			const error = new Error();
			// @ts-ignore
			error.statusCode = 404;
			return Promise.reject(error);
		};
		await targetStateCache.setTargetApps([
			{
				appId: 1,
				uuid: 'test-uuid1',
				commit: 'abcdef',
				name: 'test-app',
				source: apiEndpoint,
				releaseId: 123,
				releaseVersion: '1.5.1',
				services: '[]',
				networks: '[]',
				volumes: '[]',
			},
			{
				appId: 2,
				uuid: 'test-uuid2',
				commit: 'abcdef2',
				name: 'test-app2',
				source: apiEndpoint,
				releaseId: 1232,
				releaseVersion: '0.5.1',
				services: JSON.stringify([
					{
						serviceName: 'test-service',
						image: 'test-image',
						imageId: 5,
						environment: {
							TEST_VAR: 'test-string',
						},
						tty: true,
						appId: 2,
						releaseId: 1232,
						serviceId: 567,
						commit: 'abcdef2',
					},
				]),
				networks: '[]',
				volumes: '[]',
			},
		]);
	});

	after(async () => {
		await prepare();

		// @ts-expect-error Assigning to a RO property
		images.inspectByName = originalInspect;
	});

	it('should retrieve a single app from the database', async () => {
		const app = await dbFormat.getApp(1);
		expect(app).to.be.an.instanceOf(App);
		expect(app).to.have.property('appId').that.equals(1);
		expect(app).to.have.property('commit').that.equals('abcdef');
		expect(app).to.have.property('releaseId').that.equals(123);
		expect(app).to.have.property('appName').that.equals('test-app');
		expect(app)
			.to.have.property('source')
			.that.deep.equals(await config.get('apiEndpoint'));
		expect(app).to.have.property('services').that.deep.equals([]);
		expect(app).to.have.property('volumes').that.deep.equals({});
		expect(app)
			.to.have.property('networks')
			.that.deep.equals(getDefaultNetworks(1, 'test-uuid1'));
	});

	it('should correctly build services from the database', async () => {
		const app = await dbFormat.getApp(2);
		expect(app).to.have.property('services').that.is.an('array');
		const services = _.keyBy(app.services, 'serviceId');
		expect(Object.keys(services)).to.deep.equal(['567']);

		const service = services[567];
		expect(service).to.be.instanceof(Service);
		// Don't do a deep equals here as a bunch of other properties are added that are
		// tested elsewhere
		expect(service.config)
			.to.have.property('environment')
			.that.has.property('TEST_VAR')
			.that.equals('test-string');
		expect(service.config).to.have.property('tty').that.equals(true);
		expect(service).to.have.property('imageName').that.equals('test-image');
		expect(service).to.have.property('imageId').that.equals(5);
	});

	it('should retrieve multiple apps from the database', async () => {
		const apps = await dbFormat.getApps();
		expect(Object.keys(apps)).to.have.length(2).and.deep.equal(['1', '2']);
	});

	it('should write target states to the database', async () => {
		const target = await import('./data/state-endpoints/simple.json');
		const dbApps: { [appId: number]: TargetApplication } = {};
		dbApps[1234] = {
			...target.local.apps['test-uuid'],
		};

		await dbFormat.setApps(dbApps, apiEndpoint);

		const app = await dbFormat.getApp(1234);

		expect(app).to.have.property('appName').that.equals('pi4test');
		expect(app).to.have.property('services').that.is.an('array');
		expect(_.keyBy(app.services, 'serviceId'))
			.to.have.property('482141')
			.that.has.property('serviceName')
			.that.equals('main');
	});

	it('should add default and missing fields when retreiving from the database', async () => {
		const originalImagesInspect = images.inspectByName;
		try {
			// @ts-expect-error Assigning a RO property
			images.inspectByName = () =>
				Promise.resolve({
					Config: { Cmd: ['someCommand'], Entrypoint: ['theEntrypoint'] },
				});

			const app = await dbFormat.getApp(2);
			const conf =
				app.services[parseInt(Object.keys(app.services)[0], 10)].config;
			expect(conf)
				.to.have.property('entrypoint')
				.that.deep.equals(['theEntrypoint']);
			expect(conf)
				.to.have.property('command')
				.that.deep.equals(['someCommand']);
		} finally {
			// @ts-expect-error Assigning a RO property
			images.inspectByName = originalImagesInspect;
		}
	});
});
