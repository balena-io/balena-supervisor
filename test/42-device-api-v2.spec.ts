import { expect } from 'chai';
import { stub, SinonStub, spy, SinonSpy } from 'sinon';
import * as supertest from 'supertest';
import * as Bluebird from 'bluebird';

import sampleResponses = require('./data/device-api-responses.json');
import mockedAPI = require('./lib/mocked-device-api');
import * as apiBinder from '../src/api-binder';
import * as deviceState from '../src/device-state';
import SupervisorAPI from '../src/supervisor-api';
import * as serviceManager from '../src/compose/service-manager';
import * as images from '../src/compose/images';
import * as apiKeys from '../src/lib/api-keys';
import * as config from '../src/config';
import * as updateLock from '../src/lib/update-lock';
import * as targetStateCache from '../src/device-state/target-state-cache';
import * as mockedDockerode from './lib/mocked-dockerode';
import * as applicationManager from '../src/compose/application-manager';
import * as logger from '../src/logger';

import { UpdatesLockedError } from '../src/lib/errors';

describe('SupervisorAPI [V2 Endpoints]', () => {
	let serviceManagerMock: SinonStub;
	let imagesMock: SinonStub;
	let applicationManagerSpy: SinonSpy;
	let api: SupervisorAPI;
	const request = supertest(
		`http://127.0.0.1:${mockedAPI.mockedOptions.listenPort}`,
	);

	let loggerStub: SinonStub;

	before(async () => {
		await apiBinder.initialized;
		await deviceState.initialized;

		// The mockedAPI contains stubs that might create unexpected results
		// See the module to know what has been stubbed
		api = await mockedAPI.create();

		// Start test API
		await api.listen(
			mockedAPI.mockedOptions.listenPort,
			mockedAPI.mockedOptions.timeout,
		);

		// Create a scoped key
		await apiKeys.initialized;
		await apiKeys.generateCloudKey();
		serviceManagerMock = stub(serviceManager, 'getAll').resolves([]);
		imagesMock = stub(images, 'getStatus').resolves([]);

		// We want to check the actual step that was triggered
		applicationManagerSpy = spy(applicationManager, 'executeStep');

		// Stub logs for all API methods
		loggerStub = stub(logger, 'attach');
		loggerStub.resolves();
	});

	after(async () => {
		try {
			await api.stop();
		} catch (e) {
			if (e.message !== 'Server is not running.') {
				throw e;
			}
		}
		// Remove any test data generated
		await mockedAPI.cleanUp();
		serviceManagerMock.restore();
		imagesMock.restore();
		applicationManagerSpy.restore();
		loggerStub.restore();
	});

	afterEach(() => {
		mockedDockerode.resetHistory();
		applicationManagerSpy.resetHistory();
	});

	describe('GET /v2/device/vpn', () => {
		it('returns information about VPN connection', async () => {
			await request
				.get('/v2/device/vpn')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect('Content-Type', /json/)
				.expect(sampleResponses.V2.GET['/device/vpn'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/device/vpn'].body,
					);
				});
		});
	});

	describe('GET /v2/applications/:appId/state', () => {
		it('returns information about a SPECIFIC application', async () => {
			await request
				.get('/v2/applications/1/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(sampleResponses.V2.GET['/applications/1/state'].statusCode)
				.expect('Content-Type', /json/)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/1/state'].body,
					);
				});
		});

		it('returns 400 for invalid appId', async () => {
			await request
				.get('/v2/applications/123invalid/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/applications/123invalid/state'].statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/123invalid/state'].body,
					);
				});
		});

		it('returns 409 because app does not exist', async () => {
			await request
				.get('/v2/applications/9000/state')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${apiKeys.cloudApiKey}`)
				.expect(sampleResponses.V2.GET['/applications/9000/state'].statusCode)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/applications/9000/state'].body,
					);
				});
		});

		describe('Scoped API Keys', () => {
			it('returns 409 because app is out of scope of the key', async () => {
				const apiKey = await apiKeys.generateScopedKey(3, 1);
				await request
					.get('/v2/applications/2/state')
					.set('Accept', 'application/json')
					.set('Authorization', `Bearer ${apiKey}`)
					.expect(409);
			});
		});
	});

	describe('GET /v2/state/status', () => {
		before(() => {
			// Stub isApplyInProgress is no other tests can impact the response data
			stub(deviceState, 'isApplyInProgress').returns(false);
		});

		after(() => {
			(deviceState.isApplyInProgress as SinonStub).restore();
		});

		it('should return scoped application', async () => {
			// Create scoped key for application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);
			// Setup device conditions
			serviceManagerMock.resolves([mockedAPI.mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockedAPI.mockImage({ appId: 1658654 })]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});

		it('should return no application info due to lack of scope', async () => {
			// Create scoped key for wrong application
			const appScopedKey = await apiKeys.generateScopedKey(1, 1);
			// Setup device conditions
			serviceManagerMock.resolves([mockedAPI.mockService({ appId: 1658654 })]);
			imagesMock.resolves([mockedAPI.mockImage({ appId: 1658654 })]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=no_applications']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=no_applications'].body,
					);
				});
		});

		it('should return success when device has no applications', async () => {
			// Create scoped key for any application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 1658654);
			// Setup device conditions
			serviceManagerMock.resolves([]);
			imagesMock.resolves([]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=no_applications']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=no_applications'].body,
					);
				});
		});

		it('should only return 1 application when N > 1 applications on device', async () => {
			// Create scoped key for application
			const appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);
			// Setup device conditions
			serviceManagerMock.resolves([
				mockedAPI.mockService({ appId: 1658654 }),
				mockedAPI.mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockedAPI.mockImage({ appId: 1658654 }),
				mockedAPI.mockImage({ appId: 222222 }),
			]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.set('Authorization', `Bearer ${appScopedKey}`)
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});

		it('should only return 1 application when in LOCAL MODE (no auth)', async () => {
			// Activate localmode
			await config.set({ localMode: true });
			// Setup device conditions
			serviceManagerMock.resolves([
				mockedAPI.mockService({ appId: 1658654 }),
				mockedAPI.mockService({ appId: 222222 }),
			]);
			imagesMock.resolves([
				mockedAPI.mockImage({ appId: 1658654 }),
				mockedAPI.mockImage({ appId: 222222 }),
			]);
			// Make request and evaluate response
			await request
				.get('/v2/state/status')
				.set('Accept', 'application/json')
				.expect('Content-Type', /json/)
				.expect(
					sampleResponses.V2.GET['/state/status?desc=single_application']
						.statusCode,
				)
				.then((response) => {
					expect(response.body).to.deep.equal(
						sampleResponses.V2.GET['/state/status?desc=single_application']
							.body,
					);
				});
		});
	});

	// TODO: setup for this test is wrong, which leads to inconsistent data being passed to
	// manager methods. A refactor is needed
	describe.skip('POST /v2/applications/:appId/start-service', function () {
		let appScopedKey: string;
		let targetStateCacheMock: SinonStub;
		let lockMock: SinonStub;

		const service = {
			serviceName: 'main',
			containerId: 'abc123',
			appId: 1658654,
			serviceId: 640681,
		};

		const mockContainers = [mockedAPI.mockService(service)];
		const mockImages = [mockedAPI.mockImage(service)];

		beforeEach(() => {
			// Setup device conditions
			serviceManagerMock.resolves(mockContainers);
			imagesMock.resolves(mockImages);

			targetStateCacheMock.resolves({
				appId: 2,
				commit: 'abcdef2',
				name: 'test-app2',
				source: 'https://api.balena-cloud.com',
				releaseId: 1232,
				services: JSON.stringify([service]),
				networks: '[]',
				volumes: '[]',
			});

			lockMock.reset();
		});

		before(async () => {
			// Create scoped key for application
			appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);

			// Mock target state cache
			targetStateCacheMock = stub(targetStateCache, 'getTargetApp');

			lockMock = stub(updateLock, 'lock');
		});

		after(async () => {
			targetStateCacheMock.restore();
			lockMock.restore();
		});

		it.skip('should return 200 for an existing service', async () => {
			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/start-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main' })
						.set('Content-type', 'application/json')
						.expect(200);

					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});

		it('should return 404 for an unknown service', async () => {
			await mockedDockerode.testWithData({}, async () => {
				await request
					.post(`/v2/applications/1658654/start-service?apikey=${appScopedKey}`)
					.send({ serviceName: 'unknown' })
					.set('Content-type', 'application/json')
					.expect(404);

				expect(applicationManagerSpy).to.not.have.been.called;
			});
		});

		it('should ignore locks and return 200', async () => {
			// Turn lock on
			lockMock.throws(new UpdatesLockedError('Updates locked'));

			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/start-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main' })
						.set('Content-type', 'application/json')
						.expect(200);

					expect(lockMock).to.not.have.been.called;
					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});
	});

	// TODO: setup for this test is wrong, which leads to inconsistent data being passed to
	// manager methods. A refactor is needed
	describe.skip('POST /v2/applications/:appId/restart-service', () => {
		let appScopedKey: string;
		let targetStateCacheMock: SinonStub;
		let lockMock: SinonStub;

		const service = {
			serviceName: 'main',
			containerId: 'abc123',
			appId: 1658654,
			serviceId: 640681,
		};

		const mockContainers = [mockedAPI.mockService(service)];
		const mockImages = [mockedAPI.mockImage(service)];
		const lockFake = (_: any, opts: { force: boolean }, fn: () => any) => {
			if (opts.force) {
				return Bluebird.resolve(fn());
			}

			throw new UpdatesLockedError('Updates locked');
		};

		beforeEach(() => {
			// Setup device conditions
			serviceManagerMock.resolves(mockContainers);
			imagesMock.resolves(mockImages);

			targetStateCacheMock.resolves({
				appId: 2,
				commit: 'abcdef2',
				name: 'test-app2',
				source: 'https://api.balena-cloud.com',
				releaseId: 1232,
				services: JSON.stringify(mockContainers),
				networks: '[]',
				volumes: '[]',
			});

			lockMock.reset();
		});

		before(async () => {
			// Create scoped key for application
			appScopedKey = await apiKeys.generateScopedKey(1658654, 640681);

			// Mock target state cache
			targetStateCacheMock = stub(targetStateCache, 'getTargetApp');
			lockMock = stub(updateLock, 'lock');
		});

		after(async () => {
			targetStateCacheMock.restore();
			lockMock.restore();
		});

		it('should return 200 for an existing service', async () => {
			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/restart-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main' })
						.set('Content-type', 'application/json')
						.expect(200);

					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});

		it('should return 404 for an unknown service', async () => {
			await mockedDockerode.testWithData({}, async () => {
				await request
					.post(
						`/v2/applications/1658654/restart-service?apikey=${appScopedKey}`,
					)
					.send({ serviceName: 'unknown' })
					.set('Content-type', 'application/json')
					.expect(404);
				expect(applicationManagerSpy).to.not.have.been.called;
			});
		});

		it('should return 423 for a service with update locks', async () => {
			// Turn lock on
			lockMock.throws(new UpdatesLockedError('Updates locked'));

			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/restart-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main' })
						.set('Content-type', 'application/json')
						.expect(423);

					expect(lockMock).to.be.calledOnce;
					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});

		it('should return 200 for a service with update locks and force true', async () => {
			// Turn lock on
			lockMock.callsFake(lockFake);

			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/restart-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main', force: true })
						.set('Content-type', 'application/json')
						.expect(200);

					expect(lockMock).to.be.calledOnce;
					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});

		it('should return 423 if force is explicitely set to false', async () => {
			// Turn lock on
			lockMock.callsFake(lockFake);

			await mockedDockerode.testWithData(
				{ containers: mockContainers, images: mockImages },
				async () => {
					await request
						.post(
							`/v2/applications/1658654/restart-service?apikey=${appScopedKey}`,
						)
						.send({ serviceName: 'main', force: false })
						.set('Content-type', 'application/json')
						.expect(423);

					expect(lockMock).to.be.calledOnce;
					expect(applicationManagerSpy).to.have.been.calledOnce;
				},
			);
		});
	});

	// TODO: add tests for rest of V2 endpoints
});
