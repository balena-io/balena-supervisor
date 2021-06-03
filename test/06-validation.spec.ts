import * as _ from 'lodash';
import { expect } from 'chai';

import * as validation from '../src/lib/validation';

const almostTooLongText = _.times(255, () => 'a').join('');

describe('validation', () => {
	describe('checkBooleanish', () => {
		it('returns true for a truthy or falsey value', () => {
			expect(validation.checkBooleanish(true)).to.equal(true);
			expect(validation.checkBooleanish('true')).to.equal(true);
			expect(validation.checkBooleanish('1')).to.equal(true);
			expect(validation.checkBooleanish(1)).to.equal(true);
			expect(validation.checkBooleanish('on')).to.equal(true);
			expect(validation.checkBooleanish(false)).to.equal(true);
			expect(validation.checkBooleanish('false')).to.equal(true);
			expect(validation.checkBooleanish('0')).to.equal(true);
			expect(validation.checkBooleanish(0)).to.equal(true);
			expect(validation.checkBooleanish('off')).to.equal(true);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkBooleanish({})).to.equal(false);
			expect(validation.checkBooleanish(10)).to.equal(false);
			expect(validation.checkBooleanish('on1')).to.equal(false);
			expect(validation.checkBooleanish('foo')).to.equal(false);
			expect(validation.checkBooleanish(undefined)).to.equal(false);
			expect(validation.checkBooleanish(null)).to.equal(false);
			expect(validation.checkBooleanish('')).to.equal(false);
		});
	});

	describe('checkFalsey', () => {
		it('returns false for a truthy value', () => {
			expect(validation.checkFalsey(true)).to.equal(false);
			expect(validation.checkFalsey('true')).to.equal(false);
			expect(validation.checkFalsey('1')).to.equal(false);
			expect(validation.checkFalsey(1)).to.equal(false);
			expect(validation.checkFalsey('on')).to.equal(false);
		});

		it('returns true for a falsey value', () => {
			expect(validation.checkFalsey(false)).to.equal(true);
			expect(validation.checkFalsey('false')).to.equal(true);
			expect(validation.checkFalsey('0')).to.equal(true);
			expect(validation.checkFalsey(0)).to.equal(true);
			expect(validation.checkFalsey('off')).to.equal(true);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkFalsey({})).to.equal(false);
			expect(validation.checkFalsey(10)).to.equal(false);
			expect(validation.checkFalsey('on1')).to.equal(false);
			expect(validation.checkFalsey('foo')).to.equal(false);
			expect(validation.checkFalsey(undefined)).to.equal(false);
			expect(validation.checkFalsey(null)).to.equal(false);
			expect(validation.checkFalsey('')).to.equal(false);
		});
	});

	describe('checkTruthy', () => {
		it('returns true for a truthy value', () => {
			expect(validation.checkTruthy(true)).to.equal(true);
			expect(validation.checkTruthy('true')).to.equal(true);
			expect(validation.checkTruthy('1')).to.equal(true);
			expect(validation.checkTruthy(1)).to.equal(true);
			expect(validation.checkTruthy('on')).to.equal(true);
		});

		it('returns false for a falsey value', () => {
			expect(validation.checkTruthy(false)).to.equal(false);
			expect(validation.checkTruthy('false')).to.equal(false);
			expect(validation.checkTruthy('0')).to.equal(false);
			expect(validation.checkTruthy(0)).to.equal(false);
			expect(validation.checkTruthy('off')).to.equal(false);
		});

		it('returns false for invalid values', () => {
			expect(validation.checkTruthy({})).to.equal(false);
			expect(validation.checkTruthy(10)).to.equal(false);
			expect(validation.checkTruthy('on1')).to.equal(false);
			expect(validation.checkTruthy('foo')).to.equal(false);
			expect(validation.checkTruthy(undefined)).to.equal(false);
			expect(validation.checkTruthy(null)).to.equal(false);
			expect(validation.checkTruthy('')).to.equal(false);
		});
	});

	describe('checkString', () => {
		it('validates a string', () => {
			expect(validation.checkString('foo')).to.equal('foo');
			expect(validation.checkString('bar')).to.equal('bar');
		});

		it('returns undefined for empty strings or strings that equal null or undefined', () => {
			expect(validation.checkString('')).to.be.undefined;
			expect(validation.checkString('null')).to.be.undefined;
			expect(validation.checkString('undefined')).to.be.undefined;
		});

		it('returns undefined for things that are not strings', () => {
			expect(validation.checkString({})).to.be.undefined;
			expect(validation.checkString([])).to.be.undefined;
			expect(validation.checkString(123)).to.be.undefined;
			expect(validation.checkString(0)).to.be.undefined;
			expect(validation.checkString(null)).to.be.undefined;
			expect(validation.checkString(undefined)).to.be.undefined;
		});
	});

	describe('checkInt', () => {
		it('returns an integer for a string that can be parsed as one', () => {
			expect(validation.checkInt('200')).to.equal(200);
			expect(validation.checkInt('200.00')).to.equal(200); // Allow since no data is being lost
			expect(validation.checkInt('0')).to.equal(0);
			expect(validation.checkInt('-3')).to.equal(-3);
		});

		it('returns the same integer when passed an integer', () => {
			expect(validation.checkInt(345)).to.equal(345);
			expect(validation.checkInt(-345)).to.equal(-345);
		});

		it("returns undefined when passed something that can't be parsed as int", () => {
			expect(validation.checkInt({})).to.be.undefined;
			expect(validation.checkInt([])).to.be.undefined;
			expect(validation.checkInt('foo')).to.be.undefined;
			expect(validation.checkInt('')).to.be.undefined;
			expect(validation.checkInt(null)).to.be.undefined;
			expect(validation.checkInt(undefined)).to.be.undefined;
			expect(validation.checkInt('45notanumber')).to.be.undefined;
			expect(validation.checkInt('000123.45notanumber')).to.be.undefined;
			expect(validation.checkInt(50.55)).to.be.undefined; // Fractional digits
			expect(validation.checkInt('50.55')).to.be.undefined; // Fractional digits
			expect(validation.checkInt('0x11')).to.be.undefined; // Hexadecimal
			expect(validation.checkInt('0b11')).to.be.undefined; // Binary
			expect(validation.checkInt('0o11')).to.be.undefined; // Octal
		});

		it('returns undefined when passed a negative or zero value and the positive option is set', () => {
			expect(validation.checkInt('-3', { positive: true })).to.be.undefined;
			expect(validation.checkInt('0', { positive: true })).to.be.undefined;
		});
	});

	describe('isValidShortText', () => {
		it('returns true for a short text', () => {
			expect(validation.isValidShortText('foo')).to.equal(true);
			expect(validation.isValidShortText('')).to.equal(true);
			expect(validation.isValidShortText(almostTooLongText)).to.equal(true);
		});
		it('returns false for a text longer than 255 characters', () =>
			expect(validation.isValidShortText(almostTooLongText + 'a')).to.equal(
				false,
			));

		it('returns false when passed a non-string', () => {
			expect(validation.isValidShortText({})).to.equal(false);
			expect(validation.isValidShortText(1)).to.equal(false);
			expect(validation.isValidShortText(null)).to.equal(false);
			expect(validation.isValidShortText(undefined)).to.equal(false);
		});
	});

	describe('isValidAppsObject', () => {
		it('returns true for a valid object', () => {
			const apps = {
				uuid: {
					name: 'something',
					appId: 1234,
					releaseId: 123,
					commit: 'bar',
					services: {
						'45': {
							serviceName: 'bazbaz',
							imageId: 34,
							image: 'foo',
							environment: {},
							labels: {},
						},
					},
				},
			};
			expect(validation.isValidAppsObject(apps)).to.equal(true);
		});

		it('returns false with an invalid environment', () => {
			const apps = {
				'1234': {
					name: 'something',
					appId: 1234,
					releaseId: 123,
					commit: 'bar',
					services: {
						'45': {
							serviceName: 'bazbaz',
							imageId: 34,
							image: 'foo',
							environment: { ' baz': 'bat' },
							labels: {},
						},
					},
				},
			};
			expect(validation.isValidAppsObject(apps)).to.equal(false);
		});

		it('returns false with an invalid appId', () => {
			const apps = {
				uuid: {
					name: 'something',
					appId: 'test',
					releaseId: 123,
					commit: 'bar',
					services: {
						'45': {
							serviceName: 'bazbaz',
							imageId: 34,
							image: 'foo',
							environment: {},
							labels: {},
						},
					},
				},
			};
			expect(validation.isValidAppsObject(apps)).to.equal(false);
		});

		it('returns true with a missing releaseId', () => {
			const apps = {
				'1234': {
					name: 'something',
					appId: 1234,
					services: {
						'45': {
							serviceName: 'bazbaz',
							imageId: 34,
							image: 'foo',
							environment: {},
							labels: {},
						},
					},
				},
			};
			expect(validation.isValidAppsObject(apps)).to.equal(true);
		});

		it('returns false with an invalid releaseId', () => {
			const apps = {
				'1234': {
					name: 'something',
					releaseId: '123a',
					services: {
						'45': {
							serviceName: 'bazbaz',
							imageId: 34,
							image: 'foo',
							environment: {},
							labels: {},
						},
					},
				},
			};
			expect(validation.isValidAppsObject(apps)).to.equal(false);
		});
	});

	describe('isValidDependentDevicesObject', () => {
		it('returns true for a valid object', () => {
			const devices: Dictionary<any> = {};
			devices[almostTooLongText] = {
				name: 'foo',
				apps: {
					'234': {
						config: { bar: 'baz' },
						environment: { dead: 'beef' },
					},
				},
			};
			expect(validation.isValidDependentDevicesObject(devices)).to.equal(true);
		});

		it('returns false with a missing apps object', () => {
			const devices = {
				abcd1234: {
					name: 'foo',
				},
			};
			expect(validation.isValidDependentDevicesObject(devices)).to.equal(false);
		});

		it('returns false with an invalid environment', () => {
			const devices = {
				abcd1234: {
					name: 'foo',
					apps: {
						'234': {
							config: { bar: 'baz' },
							environment: { dead: 1 },
						},
					},
				},
			};
			expect(validation.isValidDependentDevicesObject(devices)).to.equal(false);
		});

		it('returns false if the uuid is too long', () => {
			const devices: Dictionary<any> = {};
			devices[almostTooLongText + 'a'] = {
				name: 'foo',
				apps: {
					'234': {
						config: { bar: 'baz' },
						environment: { dead: 'beef' },
					},
				},
			};
			expect(validation.isValidDependentDevicesObject(devices)).to.equal(false);
		});
	});
});
