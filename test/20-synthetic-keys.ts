import ConfigJsonConfigBacked from '../src/config/configJson';

import { expect } from 'chai';

describe('Config.json Synthetic keys', () => {
	const cacheFormat = {
		test: 'test1',
		test2: 'test3',
		udevRules: { '11': 'a udev rule', '12': 'another udev rule' },
	};
	const diskFormat = {
		test: 'test1',
		test2: 'test3',
		os: {
			udevRules: {
				11: 'a udev rule',
				12: 'another udev rule',
			},
		},
	};
	it('Should correctly convert udev rules to their disk format', () => {
		expect(ConfigJsonConfigBacked.cacheToDiskFormat(cacheFormat)).to.deep.equal(
			diskFormat,
		);
	});
	it('should correctly convert udev rules to their cache format', () => {
		expect(ConfigJsonConfigBacked.diskToCacheFormat(diskFormat)).to.deep.equal(
			cacheFormat,
		);
	});
});
