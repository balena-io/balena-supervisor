import * as mixpanel from 'mixpanel';
import { SinonStub, stub, spy, SinonSpy } from 'sinon';

import { expect } from './lib/chai-config';

import log from '../src/lib/supervisor-console';
import supervisorVersion from '../src/lib/supervisor-version';
import * as config from '../src/config';

describe('EventTracker', () => {
	let logEventStub: SinonStub;
	before(() => {
		logEventStub = stub(log, 'event');

		delete require.cache[require.resolve('../src/event-tracker')];
	});

	afterEach(() => {
		logEventStub.reset();
	});

	after(() => {
		logEventStub.restore();
	});

	describe('Unmanaged', () => {
		let configStub: SinonStub;
		let eventTracker: typeof import('../src/event-tracker');

		before(async () => {
			configStub = stub(config, 'getMany').returns(
				Promise.resolve({
					unmanaged: true,
					uuid: 'foobar',
					mixpanelHost: { host: '', path: '' },
					mixpanelToken: '',
				}) as any,
			);

			eventTracker = await import('../src/event-tracker');
		});

		after(() => {
			configStub.restore();

			delete require.cache[require.resolve('../src/event-tracker')];
		});

		it('initializes in unmanaged mode', () => {
			expect(eventTracker.initialized).to.be.fulfilled.then(() => {
				expect(eventTracker.client).to.be.null;
			});
		});

		it('logs events in unmanaged mode, with the correct properties', async () => {
			await eventTracker.track('Test event', { appId: 'someValue' });
			expect(logEventStub).to.be.calledWith(
				'Event:',
				'Test event',
				JSON.stringify({ appId: 'someValue' }),
			);
		});
	});

	describe('Init', () => {
		let eventTracker: typeof import('../src/event-tracker');
		let configStub: SinonStub;
		let mixpanelSpy: SinonSpy;

		before(async () => {
			configStub = stub(config, 'getMany').returns(
				Promise.resolve({
					mixpanelToken: 'someToken',
					uuid: 'barbaz',
					mixpanelHost: { host: '', path: '' },
					unmanaged: false,
				}) as any,
			);

			mixpanelSpy = spy(mixpanel, 'init');

			eventTracker = await import('../src/event-tracker');
		});

		after(() => {
			configStub.restore();
			mixpanelSpy.restore();

			delete require.cache[require.resolve('../src/event-tracker')];
		});

		it('initializes a mixpanel client when not in unmanaged mode', () => {
			expect(eventTracker.initialized).to.be.fulfilled.then(() => {
				expect(mixpanel.init).to.have.been.calledWith('someToken');
				// @ts-ignore
				expect(eventTracker.client.token).to.equal('someToken');
				// @ts-ignore
				expect(eventTracker.client.track).to.be.a('function');
			});
		});
	});

	describe('Managed', () => {
		let eventTracker: typeof import('../src/event-tracker');
		let configStub: SinonStub;
		let mixpanelStub: SinonStub;

		before(async () => {
			configStub = stub(config, 'getMany').returns(
				Promise.resolve({
					mixpanelToken: 'someToken',
					uuid: 'barbaz',
					mixpanelHost: { host: '', path: '' },
					unmanaged: false,
				}) as any,
			);

			mixpanelStub = stub(mixpanel, 'init').returns({
				token: 'someToken',
				track: stub(),
			} as any);

			eventTracker = await import('../src/event-tracker');
			await eventTracker.initialized;
		});

		after(() => {
			configStub.restore();
			mixpanelStub.restore();

			delete require.cache[require.resolve('../src/event-tracker')];
		});

		it('calls the mixpanel client track function with the event, properties and uuid as distinct_id', async () => {
			await eventTracker.track('Test event 2', { appId: 'someOtherValue' });

			expect(logEventStub).to.be.calledWith(
				'Event:',
				'Test event 2',
				JSON.stringify({ appId: 'someOtherValue' }),
			);
			// @ts-ignore
			expect(eventTracker.client.track).to.be.calledWith('Test event 2', {
				appId: 'someOtherValue',
				uuid: 'barbaz',
				distinct_id: 'barbaz',
				supervisorVersion,
			});
		});

		it('can be passed an Error and it is added to the event properties', async () => {
			const theError = new Error('something went wrong');
			await eventTracker.track('Error event', theError);
			// @ts-ignore
			expect(eventTracker.client.track).to.be.calledWith('Error event', {
				error: {
					message: theError.message,
					stack: theError.stack,
				},
				uuid: 'barbaz',
				distinct_id: 'barbaz',
				supervisorVersion,
			});
		});

		it('hides service environment variables, to avoid logging keys or secrets', async () => {
			const props = {
				service: {
					appId: '1',
					environment: {
						RESIN_API_KEY: 'foo',
						RESIN_SUPERVISOR_API_KEY: 'bar',
						OTHER_VAR: 'hi',
					},
				},
			};
			await eventTracker.track('Some app event', props);
			// @ts-ignore
			expect(eventTracker.client.track).to.be.calledWith('Some app event', {
				service: { appId: '1' },
				uuid: 'barbaz',
				distinct_id: 'barbaz',
				supervisorVersion,
			});
		});

		it('should handle being passed no properties object', () => {
			expect(eventTracker.track('no-options')).to.be.fulfilled;
		});
	});

	describe('Rate limiting', () => {
		let eventTracker: typeof import('../src/event-tracker');
		let mixpanelStub: SinonStub;

		before(async () => {
			mixpanelStub = stub(mixpanel, 'init').returns({
				track: stub(),
			} as any);
			eventTracker = await import('../src/event-tracker');
			await eventTracker.initialized;
		});

		after(() => {
			mixpanelStub.restore();

			delete require.cache[require.resolve('../src/event-tracker')];
		});

		it('should rate limit events of the same type', async () => {
			// @ts-expect-error resetting a non-stub typed function
			eventTracker.client?.track.reset();

			await eventTracker.track('test', {});
			await eventTracker.track('test', {});
			await eventTracker.track('test', {});
			await eventTracker.track('test', {});
			await eventTracker.track('test', {});

			expect(eventTracker.client?.track).to.have.callCount(1);
		});

		it('should rate limit events of the same type with different arguments', async () => {
			// @ts-expect-error resetting a non-stub typed function
			eventTracker.client?.track.reset();

			await eventTracker.track('test2', { a: 1 });
			await eventTracker.track('test2', { b: 2 });
			await eventTracker.track('test2', { c: 3 });
			await eventTracker.track('test2', { d: 4 });
			await eventTracker.track('test2', { e: 5 });

			expect(eventTracker.client?.track).to.have.callCount(1);
		});

		it('should not rate limit events of different types', async () => {
			// @ts-expect-error resetting a non-stub typed function
			eventTracker.client?.track.reset();

			await eventTracker.track('test3', { a: 1 });
			await eventTracker.track('test4', { b: 2 });
			await eventTracker.track('test5', { c: 3 });
			await eventTracker.track('test6', { d: 4 });
			await eventTracker.track('test7', { e: 5 });

			expect(eventTracker.client?.track).to.have.callCount(5);
		});
	});
});
