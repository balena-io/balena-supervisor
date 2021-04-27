import { fs } from 'mz';
import { expect } from './lib/chai-config';

import blink from '../src/lib/blink';
import constants = require('../src/lib/constants');

describe('blink', () => {
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
