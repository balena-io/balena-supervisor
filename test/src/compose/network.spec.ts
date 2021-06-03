import { expect } from 'chai';
import * as sinon from 'sinon';

import { Network } from '../../../src/compose/network';
import { NetworkInspectInfo } from 'dockerode';

import { log } from '../../../src/lib/supervisor-console';

describe('compose/network', () => {
	describe('creating a network from a compose object', () => {
		it('creates a default network configuration if no config is given', () => {
			const network = Network.fromComposeObject(
				'default',
				12345,
				'deadc0de',
				{},
			);

			expect(network.name).to.equal('default');
			expect(network.appId).to.equal(12345);
			expect(network.uuid).to.equal('deadc0de');

			// Default configuration options
			expect(network.config.driver).to.equal('bridge');
			expect(network.config.ipam).to.deep.equal({
				driver: 'default',
				config: [],
				options: {},
			});
			expect(network.config.enableIPv6).to.equal(false);
			expect(network.config.labels).to.deep.equal({
				'io.balena.app-uuid': 'deadc0de',
			});
			expect(network.config.options).to.deep.equal({});
		});

		it('normalizes legacy labels', () => {
			const network = Network.fromComposeObject('default', 12345, 'deadc0de', {
				labels: {
					'io.resin.features.something': '1234',
				},
			});

			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '1234',
				'io.balena.app-uuid': 'deadc0de',
			});
		});

		it('accepts valid IPAM configurations', () => {
			const network0 = Network.fromComposeObject('default', 12345, 'deadc0de', {
				ipam: { driver: 'dummy', config: [], options: {} },
			});

			// Default configuration options
			expect(network0.config.ipam).to.deep.equal({
				driver: 'dummy',
				config: [],
				options: {},
			});

			const network1 = Network.fromComposeObject('default', 12345, 'deadc0de', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
							ip_range: '172.20.10.0/24',
							aux_addresses: { host0: '172.20.10.15', host1: '172.20.10.16' },
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});

			// Default configuration options
			expect(network1.config.ipam).to.deep.equal({
				driver: 'default',
				config: [
					{
						subnet: '172.20.0.0/16',
						ipRange: '172.20.10.0/24',
						gateway: '172.20.0.1',
						auxAddress: { host0: '172.20.10.15', host1: '172.20.10.16' },
					},
				],
				options: {},
			});
		});

		it('warns about IPAM configuration without both gateway and subnet', () => {
			const logSpy = sinon.spy(log, 'warn');

			Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
						},
					],
					options: {},
				},
			});

			expect(logSpy).to.be.called.calledOnce;
			expect(logSpy).to.be.called.calledWithMatch(
				'Network IPAM config entries must have both a subnet and gateway',
			);

			logSpy.resetHistory();

			Network.fromComposeObject('default', 12345, 'deadbeef', {
				ipam: {
					driver: 'default',
					config: [
						{
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});

			expect(logSpy).to.be.called.calledOnce;
			expect(logSpy).to.be.called.calledWithMatch(
				'Network IPAM config entries must have both a subnet and gateway',
			);

			logSpy.restore();
		});

		it('parses values from a compose object', () => {
			const network1 = Network.fromComposeObject('default', 12345, 'deadbeef', {
				driver: 'bridge',
				enable_ipv6: true,
				internal: false,
				ipam: {
					driver: 'default',
					options: {
						'com.docker.ipam-option': 'abcd',
					},
					config: [
						{
							subnet: '172.18.0.0/16',
							gateway: '172.18.0.1',
						},
					],
				},
				driver_opts: {
					'com.docker.network-option': 'abcd',
				},
				labels: {
					'com.docker.some-label': 'yes',
				},
			});

			const dockerConfig = network1.toDockerConfig();

			expect(dockerConfig.Driver).to.equal('bridge');
			// Check duplicate forced to be true
			expect(dockerConfig.CheckDuplicate).to.equal(true);
			expect(dockerConfig.Internal).to.equal(false);
			expect(dockerConfig.EnableIPv6).to.equal(true);

			expect(dockerConfig.IPAM).to.deep.equal({
				Driver: 'default',
				Options: {
					'com.docker.ipam-option': 'abcd',
				},
				Config: [
					{
						Subnet: '172.18.0.0/16',
						Gateway: '172.18.0.1',
					},
				],
			});

			expect(dockerConfig.Labels).to.deep.equal({
				'io.balena.supervised': 'true',
				'com.docker.some-label': 'yes',
				'io.balena.app-uuid': 'deadbeef',
			});

			expect(dockerConfig.Options).to.deep.equal({
				'com.docker.network-option': 'abcd',
			});
		});
	});

	describe('creating a network from docker engine state', () => {
		it('rejects networks without the proper name format', () => {
			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd_1234',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: 'abcd_abcd',
				} as NetworkInspectInfo),
			).to.throw();

			expect(() =>
				Network.fromDockerNetwork({
					Id: 'deadbeef',
					Name: '1234',
				} as NetworkInspectInfo),
			).to.throw();
		});

		it('creates a network object from a docker network configuration', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: '1234_default',
				Driver: 'bridge',
				EnableIPv6: true,
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [
						{
							Subnet: '172.18.0.0/16',
							Gateway: '172.18.0.1',
						},
					],
				} as NetworkInspectInfo['IPAM'],
				Internal: true,
				Containers: {},
				Options: {
					'com.docker.some-option': 'abcd',
				} as NetworkInspectInfo['Options'],
				Labels: {
					'io.balena.features.something': '123',
					'io.balena.app-uuid': 'deadc0de',
				} as NetworkInspectInfo['Labels'],
			} as NetworkInspectInfo);

			expect(network.appId).to.equal(1234);
			expect(network.uuid).to.equal('deadc0de');
			expect(network.name).to.equal('default');
			expect(network.config.enableIPv6).to.equal(true);
			expect(network.config.ipam.driver).to.equal('default');
			expect(network.config.ipam.options).to.deep.equal({});
			expect(network.config.ipam.config).to.deep.equal([
				{
					subnet: '172.18.0.0/16',
					gateway: '172.18.0.1',
				},
			]);
			expect(network.config.internal).to.equal(true);
			expect(network.config.options).to.deep.equal({
				'com.docker.some-option': 'abcd',
			});
			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.app-uuid': 'deadc0de',
			});
		});

		it('normalizes legacy label names and excludes supervised label', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: '1234_default',
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [],
				} as NetworkInspectInfo['IPAM'],
				Labels: {
					'io.balena.app-uuid': 'deadc0de',
					'io.resin.features.something': '123',
					'io.balena.features.dummy': 'abc',
					'io.balena.supervised': 'true',
				} as NetworkInspectInfo['Labels'],
			} as NetworkInspectInfo);

			expect(network.config.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.app-uuid': 'deadc0de',
				'io.balena.features.dummy': 'abc',
			});
		});
	});

	describe('creating a network compose configuration from a network instance', () => {
		it('creates a docker compose network object from the internal network config', () => {
			const network = Network.fromDockerNetwork({
				Id: 'deadbeef',
				Name: '1234_default',
				Driver: 'bridge',
				EnableIPv6: true,
				IPAM: {
					Driver: 'default',
					Options: {},
					Config: [
						{
							Subnet: '172.18.0.0/16',
							Gateway: '172.18.0.1',
						},
					],
				} as NetworkInspectInfo['IPAM'],
				Internal: true,
				Containers: {},
				Options: {
					'com.docker.some-option': 'abcd',
				} as NetworkInspectInfo['Options'],
				Labels: {
					'io.balena.features.something': '123',
					'io.balena.app-uuid': 'deadc0de',
				} as NetworkInspectInfo['Labels'],
			} as NetworkInspectInfo);

			// Convert to compose object
			const compose = network.toComposeObject();
			expect(compose.driver).to.equal('bridge');
			expect(compose.driver_opts).to.deep.equal({
				'com.docker.some-option': 'abcd',
			});
			expect(compose.enable_ipv6).to.equal(true);
			expect(compose.internal).to.equal(true);
			expect(compose.ipam).to.deep.equal({
				driver: 'default',
				options: {},
				config: [
					{
						subnet: '172.18.0.0/16',
						gateway: '172.18.0.1',
					},
				],
			});
			expect(compose.labels).to.deep.equal({
				'io.balena.features.something': '123',
				'io.balena.app-uuid': 'deadc0de',
			});
		});
	});

	describe('generateDockerName', () => {
		it('creates a proper network name from the user given name and the app id', () => {
			expect(Network.generateDockerName(12345, 'default')).to.equal(
				'12345_default',
			);
			expect(Network.generateDockerName(12345, 'bleh')).to.equal('12345_bleh');
			expect(Network.generateDockerName(1, 'default')).to.equal('1_default');
		});
	});

	describe('comparing network configurations', () => {
		it('ignores IPAM configuration', () => {
			const network = Network.fromComposeObject('default', 12345, 'deadc0de', {
				ipam: {
					driver: 'default',
					config: [
						{
							subnet: '172.20.0.0/16',
							ip_range: '172.20.10.0/24',
							gateway: '172.20.0.1',
						},
					],
					options: {},
				},
			});
			expect(
				network.isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {}),
				),
			).to.be.true;

			// Only ignores ipam.config, not other ipam elements
			expect(
				network.isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {
						ipam: { driver: 'aaa' },
					}),
				),
			).to.be.false;
		});

		it('compares configurations recursively', () => {
			expect(
				Network.fromComposeObject(
					'default',
					12345,
					'deadc0de',
					{},
				).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {}),
				),
			).to.be.true;
			expect(
				Network.fromComposeObject('default', 12345, 'deadc0de', {
					driver: 'default',
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {}),
				),
			).to.be.false;
			expect(
				Network.fromComposeObject('default', 12345, 'deadc0de', {
					enable_ipv6: true,
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {}),
				),
			).to.be.false;
			expect(
				Network.fromComposeObject('default', 12345, 'deadc0de', {
					enable_ipv6: false,
					internal: false,
				}).isEqualConfig(
					Network.fromComposeObject('default', 12345, 'deadc0de', {
						internal: true,
					}),
				),
			).to.be.false;
		});
	});
});
