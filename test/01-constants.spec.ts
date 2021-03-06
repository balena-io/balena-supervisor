import { expect } from 'chai';
import constants = require('../src/lib/constants');

describe('constants', function () {
	it('has the correct configJsonPathOnHost', () =>
		expect(constants.configJsonPathOnHost).to.equal('/config.json'));
	it('has the correct rootMountPoint', () =>
		expect(constants.rootMountPoint).to.equal('./test/data'));
});
