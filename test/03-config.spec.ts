import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { fs } from 'mz';

import chai = require('./lib/chai-config');
import prepare = require('./lib/prepare');

// tslint:disable-next-line
chai.use(require('chai-events'));
const { expect } = chai;

import Config from '../src/config';
import DB from '../src/db';
import * as globalEventBus from '../src/event-bus';
import constants = require('../src/lib/constants');

describe('Config', () => {
	let db: DB;
	let conf: Config;
	let initialization: Bluebird<unknown>;

	before(() => {
		prepare();
		db = new DB();
		conf = new Config({ db });

		initialization = db.init().then(() => conf.init());
	});

	it('uses the correct config.json path', async () => {
		expect(await (conf as any).configJsonBackend.path()).to.equal(
			'test/data/config.json',
		);
	});

	it('uses the correct config.json path from the root mount when passed as argument to the constructor', async () => {
		const conf2 = new Config({ db, configPath: '/foo.json' });
		expect(await (conf2 as any).configJsonBackend.path()).to.equal(
			'test/data/foo.json',
		);
	});

	it('initializes correctly', () => {
		return expect(initialization).to.be.fulfilled;
	});

	it('reads and exposes values from the config.json', async () => {
		const id = await conf.get('applicationId');
		return expect(id).to.equal(78373);
	});

	it('allows reading several values in one getMany call', async () => {
		return expect(
			await conf.getMany(['applicationId', 'apiEndpoint']),
		).to.deep.equal({
			applicationId: 78373,
			apiEndpoint: 'https://api.resin.io',
		});
	});

	it('generates a uuid and stores it in config.json', async () => {
		const uuid = await conf.get('uuid');
		const configJsonUuid = JSON.parse(
			await fs.readFile('./test/data/config.json', 'utf8'),
		).uuid;
		expect(uuid).to.be.a('string');
		expect(uuid).to.have.lengthOf(62);
		expect(uuid).to.equal(configJsonUuid);
	});

	it('does not allow setting an immutable field', async () => {
		const promise = conf.set({ username: 'somebody else' });
		// We catch it to avoid the unhandled error log
		promise.catch(_.noop);
		return expect(promise).to.be.rejected;
	});

	it('allows setting both config.json and database fields transparently', async () => {
		await conf.set({ appUpdatePollInterval: 30000, name: 'a new device name' });
		const config = await conf.getMany(['appUpdatePollInterval', 'name']);
		return expect(config).to.deep.equal({
			appUpdatePollInterval: 30000,
			name: 'a new device name',
		});
	});

	it('allows removing a db key', async () => {
		await conf.remove('apiSecret');
		const secret = await conf.get('apiSecret');
		return expect(secret).to.be.undefined;
	});

	it('allows deleting a config.json key and returns a default value if none is set', async () => {
		await conf.remove('appUpdatePollInterval');
		const poll = await conf.get('appUpdatePollInterval');
		return expect(poll).to.equal(60000);
	});

	it('allows deleting a config.json key if it is null', async () => {
		await conf.set({ apiKey: null });
		const key = await conf.get('apiKey');

		expect(key).to.be.undefined;
		expect(
			JSON.parse(await fs.readFile('./test/data/config.json', 'utf8')),
		).to.not.have.property('apiKey');
	});

	it('does not allow modifying or removing a function value', () => {
		// We have to cast to any below, as the type system will
		// not allow removing a function value
		expect(conf.remove('version' as any)).to.be.rejected;
		expect(conf.set({ version: '2.0' })).to.be.rejected;
	});

	it('throws when asked for an unknown key', () => {
		expect(conf.get('unknownInvalidValue' as any)).to.be.rejected;
	});

	it('emits a change event when values are set', done => {
		globalEventBus.getInstance().on('configChanged', val => {
			expect(val).to.deep.equal({ name: 'someValue' });
			return done();
		});
		conf.set({ name: 'someValue' });
		(expect(conf).to as any).emit('change');
	});

	it("returns an undefined OS variant if it doesn't exist", async () => {
		const oldPath = constants.hostOSVersionPath;
		constants.hostOSVersionPath = 'test/data/etc/os-release-novariant';

		const osVariant = await conf.get('osVariant');
		constants.hostOSVersionPath = oldPath;
		expect(osVariant).to.be.undefined;
	});

	describe('Function config providers', () => {
		before(async () => {
			prepare();
			db = new DB();
			conf = new Config({ db });
			await db.init();
			await conf.init();
		});

		it('should throw if a non-mutable function provider is set', () => {
			expect(conf.set({ version: 'some-version' })).to.be.rejected;
		});

		it('should throw if a non-mutable function provider is removed', () => {
			expect(conf.remove('version' as any)).to.be.rejected;
		});
	});
});
