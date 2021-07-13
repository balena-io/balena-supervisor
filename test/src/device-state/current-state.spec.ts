import { expect } from 'chai';
import { stub, SinonStub, spy, SinonSpy } from 'sinon';
import rewire = require('rewire');
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';

import { sleep } from '../../lib/helpers';

import * as config from '../../../src/config';
import * as deviceState from '../../../src/device-state';
import { stateReportErrors } from '../../../src/device-state/current-state';
import * as eventTracker from '../../../src/event-tracker';

import * as request from '../../../src/lib/request';
import log from '../../../src/lib/supervisor-console';
import {
	InternalInconsistencyError,
	StatusError,
} from '../../../src/lib/errors';
import * as sysInfo from '../../../src/lib/system-info';

describe('device-state/current-state', () => {
	// Set up rewire to track private methods and variables
	const currentState = rewire('../../../src/device-state/current-state');
	const stripDeviceStateInLocalMode = currentState.__get__(
		'stripDeviceStateInLocalMode',
	);
	const sendReportPatch = currentState.__get__('sendReportPatch');
	const getStateDiff = currentState.__get__('getStateDiff');
	const lastReportedState = currentState.__get__('lastReportedState');
	const stateForReport = currentState.__get__('stateForReport');

	const resetGlobalStateObjects = () => {
		lastReportedState.local = {};
		lastReportedState.dependent = {};
		stateForReport.local = {};
		stateForReport.dependent = {};
	};

	// Global spies & stubs
	let stubbedGetReqInstance: SinonStub;
	// Mock the patchAsync method from src/lib/request.ts
	let patchAsyncSpy: SinonSpy;
	const requestInstance = {
		patchAsync: () => Bluebird.resolve([{ statusCode: 200 }]),
	};

	// Parent-level hooks to prevent any requests from actually happening in any suites below
	before(() => {
		stubbedGetReqInstance = stub(request, 'getRequestInstance');
		stubbedGetReqInstance.resolves(requestInstance);
	});

	after(() => {
		stubbedGetReqInstance.restore();
	});

	beforeEach(() => {
		resetGlobalStateObjects();
		patchAsyncSpy = spy(requestInstance, 'patchAsync');
	});

	afterEach(() => {
		patchAsyncSpy.restore();
	});

	// Test fixtures
	const testDeviceConf = {
		uuid: 'testuuid',
		apiEndpoint: 'http://127.0.0.1',
		apiTimeout: 100,
		deviceApiKey: 'testapikey',
		deviceId: 1337,
		localMode: false,
		hardwareMetrics: true,
		developmentMode: false,
	};

	const testDeviceReportFields = {
		api_port: 48484,
		api_secret:
			'20ffbd6e15aba827dca6381912d6aeb6c3a7a7c7206d4dfadf0d2f0a9e1136',
		ip_address: '192.168.1.42 192.168.1.99',
		os_version: 'balenaOS 2.32.0+rev4',
		os_variant: 'dev',
		supervisor_version: '9.16.3',
		provisioning_progress: null,
		provisioning_state: '',
		status: 'Idle',
		update_failed: false,
		update_pending: false,
		update_downloaded: false,
		is_on__commit: 'whatever',
		logs_channel: null,
		mac_addresss: '1C:69:7A:6E:B2:FE D8:3B:BF:51:F1:E4',
	};

	const testStateConfig = {
		ENV_VAR_1: '1',
		ENV_VAR_2: '1',
	};

	const testStateApps = {
		'123': {
			services: {
				'456': {
					status: 'Downloaded',
					releaseId: '12345',
					download_progress: null,
				},
				'789': {
					status: 'Downloaded',
					releaseId: '12346',
					download_progress: null,
				},
			},
		},
	};

	const testStateApps2 = {
		'321': {
			services: {
				'654': {
					status: 'Downloaded',
					releaseId: '12347',
					download_progress: null,
				},
			},
		},
	};

	const testCurrentState = {
		local: {
			...testDeviceReportFields,
			config: testStateConfig,
			apps: testStateApps,
		},
		dependent: { apps: testStateApps2 },
		commit: 'whatever',
	};

	describe('stripDeviceStateInLocalMode', () => {
		it('should strip applications data', () => {
			const result = stripDeviceStateInLocalMode(testCurrentState);

			expect(result).to.not.have.property('dependent');

			const local = result['local'];
			expect(local).to.not.have.property('apps');
			expect(local).to.not.have.property('is_on__commit');
			expect(local).to.not.have.property('logs_channel');
		});

		it('should not mutate the input state', () => {
			const result = stripDeviceStateInLocalMode(testCurrentState);
			expect(result).to.not.deep.equal(testCurrentState);
		});
	});

	describe('sendReportPatch', () => {
		it('should only strip app state in local mode', async () => {
			// Strip state in local mode
			await sendReportPatch(testCurrentState, {
				...testDeviceConf,
				localMode: true,
			});
			// Request body's stripped state should be different than input state
			expect(patchAsyncSpy.lastCall.lastArg.body).to.not.deep.equal(
				testCurrentState,
			);

			// Don't strip state out of local mode
			await sendReportPatch(testCurrentState, testDeviceConf);
			expect(patchAsyncSpy.lastCall.lastArg.body).to.deep.equal(
				testCurrentState,
			);
		});

		it('should patch state with empty local objects depending on local mode config', async () => {
			// Don't patch state with empty state.local in local mode
			await sendReportPatch(
				{ ...testCurrentState, local: {} },
				{ ...testDeviceConf, localMode: true },
			);
			expect(patchAsyncSpy).to.not.have.been.called;

			// Patch state with empty state.local out of local mode
			await sendReportPatch({ ...testCurrentState, local: {} }, testDeviceConf);
			expect(patchAsyncSpy).to.have.been.called;
		});

		it('should patch with specified endpoint and params', async () => {
			await sendReportPatch(testCurrentState, testDeviceConf);
			const [endpoint, params] = patchAsyncSpy.lastCall.args;
			expect(endpoint).to.equal(
				`${testDeviceConf.apiEndpoint}/device/v2/${testDeviceConf.uuid}/state`,
			);
			expect(params).to.deep.equal({
				json: true,
				headers: { Authorization: `Bearer ${testDeviceConf.deviceApiKey}` },
				body: testCurrentState,
			});
		});

		it('should timeout patch request after apiTimeout milliseconds', async () => {
			// Overwrite mock patchAsync to delay past apiTimeout ms
			patchAsyncSpy.restore();
			requestInstance.patchAsync = () =>
				Bluebird.delay(
					testDeviceConf.apiTimeout + 100,
					Bluebird.resolve([{ statusCode: 200 }]),
				);
			patchAsyncSpy = spy(requestInstance, 'patchAsync');

			await expect(
				sendReportPatch(testCurrentState, testDeviceConf),
			).to.be.rejectedWith(Bluebird.TimeoutError);

			// Reset to default patchAsync
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 200 }]);
		});

		it('should communicate string error messages from the API', async () => {
			// Overwrite mock patchAsync to reject patch request
			patchAsyncSpy.restore();
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 400, body: 'string error message' }]);
			patchAsyncSpy = spy(requestInstance, 'patchAsync');

			stub(log, 'error');

			await expect(
				sendReportPatch(testCurrentState, testDeviceConf),
			).to.be.rejected.then((err) => {
				expect(err).to.be.instanceOf(StatusError);
				expect(err).to.have.property('statusMessage', '"string error message"');
			});
			expect(log.error as SinonStub).to.have.been.calledWith(
				`Error from the API: ${400}`,
			);

			// Reset to default patchAsync
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 200 }]);

			(log.error as SinonStub).restore();
		});

		it('should communicate multiline object error messages from the API', async () => {
			const objectErrorMessage = {
				testKey: 'testErrorVal',
				testChild: { testNestedKey: 'testNestedVal' },
			};
			// Overwrite mock patchAsync to reject patch request
			patchAsyncSpy.restore();
			requestInstance.patchAsync = () =>
				Bluebird.resolve([
					{
						statusCode: 400,
						body: objectErrorMessage,
					},
				]);
			patchAsyncSpy = spy(requestInstance, 'patchAsync');

			stub(log, 'error');

			await expect(
				sendReportPatch(testCurrentState, testDeviceConf),
			).to.be.rejected.then((err) => {
				expect(err).to.be.instanceOf(StatusError);
				expect(err).to.have.property(
					'statusMessage',
					JSON.stringify(objectErrorMessage, null, 2),
				);
			});
			expect(log.error as SinonStub).to.have.been.calledWith(
				`Error from the API: ${400}`,
			);

			// Reset to default patchAsync
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 200 }]);

			(log.error as SinonStub).restore();
		});
	});

	describe('getStateDiff', () => {
		it('should error if last reported state is missing local or dependent properties', () => {
			lastReportedState.local = null;
			lastReportedState.dependent = null;

			expect(() => getStateDiff()).to.throw(InternalInconsistencyError);
		});

		it('should not modify global stateForReport or lastReportedState after call', async () => {
			lastReportedState.local = {
				status: 'Downloading',
				config: testStateConfig,
			};
			stateForReport.local = {
				status: 'Idle',
				config: { ...testStateConfig, ENV_VAR_3: '1' },
			};
			getStateDiff();
			expect(lastReportedState.local).to.deep.equal({
				status: 'Downloading',
				config: {
					ENV_VAR_1: '1',
					ENV_VAR_2: '1',
				},
			});
			expect(stateForReport.local).to.deep.equal({
				status: 'Idle',
				config: {
					ENV_VAR_1: '1',
					ENV_VAR_2: '1',
					ENV_VAR_3: '1',
				},
			});
		});

		it('should return any changed fields', async () => {
			// No diffs when lastReportedState and stateForReport are the same
			expect(getStateDiff()).to.deep.equal({});

			// Changed config fields
			lastReportedState.local = {
				config: { ENV_VAR_3: '1' },
			};
			stateForReport.local = {
				config: { ENV_VAR_3: '0' },
			};
			expect(getStateDiff()).to.deep.equal({
				local: { config: { ENV_VAR_3: '0' } },
			});
			resetGlobalStateObjects();

			// Changed apps fields
			lastReportedState.local = { apps: testStateApps };
			stateForReport.local = { apps: testStateApps2 };
			expect(getStateDiff()).to.deep.equal({ local: { apps: testStateApps2 } });
			resetGlobalStateObjects();

			// Changed dependent fields
			lastReportedState.dependent = { apps: testStateApps2 };
			stateForReport.dependent = { apps: testStateApps };
			expect(getStateDiff()).to.deep.equal({
				dependent: { apps: testStateApps },
			});
			resetGlobalStateObjects();

			// Changed sys info fields
			lastReportedState.local = { cpu_temp: 10 };
			stateForReport.local = { cpu_temp: 16 };
			expect(getStateDiff()).to.deep.equal({ local: { cpu_temp: 16 } });
			resetGlobalStateObjects();
		});

		it('should omit internal state keys and report DeviceReportField (type) info', async () => {
			// INTERNAL_STATE_KEYS are: ['update_pending', 'update_downloaded', 'update_failed']
			stateForReport.local = _.pick(testDeviceReportFields, [
				'update_pending',
				'update_downloaded',
				'update_failed',
				'os_version',
			]);
			stateForReport.dependent = _.pick(testDeviceReportFields, [
				'update_pending',
				'update_downloaded',
				'update_failed',
				'status',
			]);
			expect(getStateDiff()).to.deep.equal({
				local: _.pick(testDeviceReportFields, ['os_version']),
				dependent: _.pick(testDeviceReportFields, ['status']),
			});
		});
	});

	describe('throttled report', () => {
		const report = currentState.__get__('report');

		let configGetManyStub: SinonStub;

		before(() => {
			configGetManyStub = stub(config, 'getMany');
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 200 }]);
		});

		after(() => {
			configGetManyStub.restore();
		});

		beforeEach(() => {
			configGetManyStub.resolves(
				_.omit(testDeviceConf, ['deviceId', 'hardwareMetrics']) as any,
			);
		});

		afterEach(() => {
			// Clear the throttle time limit between tests
			report.cancel();
		});

		it("doesn't report if current state hasn't changed", async () => {
			// A beforeEach hook resets the global state objects to all be empty, so
			// by default, report() will return 0 in this test env
			expect(await report()).to.equal(0);
		});

		it('errors when provided invalid uuid or apiEndpoint', async () => {
			configGetManyStub.resolves(
				_.omit(testDeviceConf, [
					'deviceId',
					'hardwareMetrics',
					'uuid',
					'apiEndpoint',
				]) as any,
			);
			stateForReport.local = { ...testDeviceReportFields };
			await expect(report()).to.be.rejectedWith(InternalInconsistencyError);
		});

		it('resets stateReportErrors to 0 on patch success', async () => {
			spy(_, 'assign');

			stateForReport.local = { ...testDeviceReportFields };
			await report();

			expect(stateReportErrors).to.equal(0);
			expect(_.assign as SinonSpy).to.have.been.calledTwice;

			(_.assign as SinonSpy).restore();
		});

		it('handles errors on state patch failure', async () => {
			// Overwrite default patchAsync response to return erroring statusCode
			patchAsyncSpy.restore();
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 400 }]);
			patchAsyncSpy = spy(requestInstance, 'patchAsync');

			stub(log, 'error');

			stateForReport.local = { ...testDeviceReportFields };
			await report();

			expect((log.error as SinonStub).lastCall.args[0]).to.equal(
				'Non-200 response from the API! Status code: 400 - message:',
			);
			(log.error as SinonStub).restore();

			// Reset to default patchAsync
			requestInstance.patchAsync = () =>
				Bluebird.resolve([{ statusCode: 200 }]);
		});
	});

	describe('reportCurrentState', () => {
		const reportCurrentState = currentState.__get__('reportCurrentState');
		const report = currentState.__get__('report');
		let testHardwareMetrics = true;
		const testAppUpdatePollInterval = 1000;

		const unhandledRejectionHandler = () => {
			/* noop */
		};

		before(() => {
			stub(deviceState, 'getStatus').resolves({});
			stub(sysInfo, 'getSystemMetrics').resolves();
			stub(sysInfo, 'getSystemChecks').resolves();
			stub(eventTracker, 'track');
			stub(config, 'get');
			(config.get as SinonStub).callsFake((conf) =>
				conf === 'hardwareMetrics'
					? Promise.resolve(testHardwareMetrics)
					: Promise.resolve(testAppUpdatePollInterval),
			);
			// We need to stub this rejection so that reportCurrentState doesn't keep calling itself
			stub(config, 'getMany').rejects();
			// We also need to stub this rejection because it's called right before
			// reportCurrentState in the catch, to prevent more calls of reportCurrentState
			stub(Bluebird, 'delay').rejects();
		});

		after(() => {
			(deviceState.getStatus as SinonStub).restore();
			(sysInfo.getSystemMetrics as SinonStub).restore();
			(sysInfo.getSystemChecks as SinonStub).restore();
			(eventTracker.track as SinonStub).restore();
			(config.get as SinonStub).restore();
			(config.getMany as SinonStub).restore();
			(Bluebird.delay as SinonStub).restore();
		});

		beforeEach(() => {
			resetGlobalStateObjects();
		});

		afterEach(() => {
			// Clear the throttle time limit between tests
			report.cancel();
		});

		it('sends a null patch for system metrics when HARDWARE_METRICS is false', async () => {
			// Use a temporary unhandledRejectionHandler to catch the promise
			// rejection from the Bluebird.delay stub
			process.on('unhandledRejection', unhandledRejectionHandler);

			testHardwareMetrics = false;

			(sysInfo.getSystemMetrics as SinonStub).resolves({ cpu_usage: 20 });
			(sysInfo.getSystemChecks as SinonStub).resolves({
				is_undervolted: false,
			});

			reportCurrentState();

			await sleep(200);

			expect(stateForReport).to.deep.equal({
				local: {
					is_undervolted: false,
					cpu_usage: null,
					memory_usage: null,
					memory_total: null,
					storage_usage: null,
					storage_total: null,
					storage_block_device: null,
					cpu_temp: null,
					cpu_id: null,
				},
				dependent: {},
			});

			process.removeListener('unhandledRejection', unhandledRejectionHandler);
		});

		it('reports both system metrics and system checks when HARDWARE_METRICS is true', async () => {
			// Use a temporary unhandledRejectionHandler to catch the promise
			// rejection from the Bluebird.delay stub
			process.on('unhandledRejection', unhandledRejectionHandler);

			testHardwareMetrics = true;

			(sysInfo.getSystemMetrics as SinonStub).resolves({ cpu_usage: 20 });
			(sysInfo.getSystemChecks as SinonStub).resolves({
				is_undervolted: false,
			});

			reportCurrentState();

			await sleep(200);

			expect(stateForReport).to.deep.equal({
				local: { is_undervolted: false, cpu_usage: 20 },
				dependent: {},
			});

			process.removeListener('unhandledRejection', unhandledRejectionHandler);
		});
	});
});
