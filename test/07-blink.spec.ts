import { promises as fs } from 'fs';
import { expect } from 'chai';
import * as mockFs from 'mock-fs';

import blink = require('../src/lib/blink');
import * as constants from '../src/lib/constants';

describe('blink', () => {
	before(() => {
		mockFs({
			[constants.ledFile]: '1',
		});
	});

	after(() => {
		mockFs.restore();
	});

	it('is a blink function', () => expect(blink).to.be.a('function'));

	it('has a pattern property with start and stop functions', () => {
		expect(blink.pattern.start).to.be.a('function');
		expect(blink.pattern.stop).to.be.a('function');
	});

	it('writes to a file that represents the LED, and writes a 0 at the end to turn the LED off', async () => {
		// TODO: Fix the typings for blink
		await (blink as any)(1);
		const contents = await fs.readFile(constants.ledFile);

		expect(contents.toString()).to.equal('0');
	});
});
