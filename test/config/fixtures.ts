import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as sinonChai from 'sinon-chai';
import * as chaiThings from 'chai-things';
import * as chaiLike from 'chai-like';

import * as mockedDbus from '../lib/mocked-dbus';

/**
 * Mocha runs this EXACTLY ONCE before all tests to set up globals that
 * are used among all test files, such as chai assertion plugins. See
 * https://mochajs.org/#test-fixture-decision-tree-wizard-thing
 *
 * IMPORTANT: The functionality in this global fixture hook should not break any
 * suite run in isolation, and it should be required by ALL test suites.
 * If unsure whether to add to global fixtures, refer to the chart above.
 * Also, avoid setting global mutable variables here.
 */
export const mochaGlobalSetup = function () {
	console.log('☕  Setting up global fixtures for tests...');

	/* Setup chai assertion plugins */
	chai.use(chaiAsPromised);
	chai.use(sinonChai);
	chai.use(chaiLike);
	chai.use(chaiThings);

	/**
	 * We need to mock dbus globally here, because there are some circular
	 * dependencies which currently make it very unclear when dbus needs
	 * to be stubbed.
	 */
	mockedDbus.mock();
};

export const mochaTeardownSetup = function () {
	console.log('☕  Tearing down global fixtures for tests...');

	mockedDbus.unmock();
};
