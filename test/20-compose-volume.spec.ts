import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';

import { docker } from '../src/lib/docker-utils';
import * as logger from '../src/logger';
import Volume from '../src/compose/volume';
import logTypes = require('../src/lib/log-types');

describe('Compose volumes', () => {
	let createVolumeStub: SinonStub;
	let logSystemStub: SinonStub;
	let logMessageStub: SinonStub;
	before(() => {
		createVolumeStub = stub(docker, 'createVolume');
		logSystemStub = stub(logger, 'logSystemEvent');
		logMessageStub = stub(logger, 'logSystemMessage');
	});
	after(() => {
		createVolumeStub.restore();
		logSystemStub.restore();
		logMessageStub.restore();
	});

	describe('Parsing volumes', () => {
		it('should correctly parse docker volumes', () => {
			const volume = Volume.fromDockerVolume({
				Driver: 'local',
				Labels: {
					'io.balena.supervised': 'true',
				},
				Mountpoint: '/var/lib/docker/volumes/1032480_one_volume/_data',
				Name: '1032480_one_volume',
				Options: {},
				Scope: 'local',
			});

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('local');
		});

		it('should correctly parse compose volumes without an explicit driver', () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'test-uuid',
				{
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
					'my-label': 'test-label',
					'io.balena.app-uuid': 'test-uuid',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({
					opt1: 'test',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('local');
		});

		it('should correctly parse compose volumes with an explicit driver', () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'test-uuid',
				{
					driver: 'other',
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			expect(volume).to.have.property('appId').that.equals(1032480);
			expect(volume).to.have.property('name').that.equals('one_volume');
			expect(volume)
				.to.have.property('config')
				.that.has.property('labels')
				.that.deep.equals({
					'io.balena.supervised': 'true',
					'my-label': 'test-label',
					'io.balena.app-uuid': 'test-uuid',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driverOpts')
				.that.deep.equals({
					opt1: 'test',
				});
			expect(volume)
				.to.have.property('config')
				.that.has.property('driver')
				.that.equals('other');
		});
	});

	describe('Generating docker options', () => {
		afterEach(() => {
			createVolumeStub.reset();
			logSystemStub.reset();
			logMessageStub.reset();
		});
		it('should correctly generate docker options', async () => {
			const volume = Volume.fromComposeObject(
				'one_volume',
				1032480,
				'test-uuid',
				{
					driver_opts: {
						opt1: 'test',
					},
					labels: {
						'my-label': 'test-label',
					},
				},
			);

			await volume.create();
			expect(
				createVolumeStub.calledWith({
					Labels: {
						'my-label': 'test-label',
						'io.balena.supervised': 'true',
						'io.balena.app-uuid': 'test-uuid',
					},
					Options: {
						opt1: 'test',
					},
				}),
			);

			expect(logSystemStub.calledWith(logTypes.createVolume));
		});
	});
});
