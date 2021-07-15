import * as Bluebird from 'bluebird';
import { stripIndent } from 'common-tags';
import * as _ from 'lodash';
import { promises as fs } from 'fs';
import * as path from 'path';

import * as config from './config';
import * as constants from './lib/constants';
import * as dbus from './lib/dbus';
import { ENOENT } from './lib/errors';
import { writeFileAtomic, mkdirp, unlinkAll } from './lib/fs-utils';

const redsocksHeader = stripIndent`
	base {
		log_debug = off;
		log_info = on;
		log = stderr;
		daemon = off;
		redirector = iptables;
	}

	redsocks {
		local_ip = 127.0.0.1;
		local_port = 12345;
`;

const redsocksFooter = '}\n';

const proxyFields = ['type', 'ip', 'port', 'login', 'password'];

const proxyBasePath = path.join(
	constants.rootMountPoint,
	constants.bootMountPoint,
	'system-proxy',
);
const redsocksConfPath = path.join(proxyBasePath, 'redsocks.conf');
const noProxyPath = path.join(proxyBasePath, 'no_proxy');

interface ProxyConfig {
	[key: string]: string | string[] | number;
}

interface HostConfig {
	network: {
		proxy?: ProxyConfig;
		hostname?: string;
	};
}

const isAuthField = (field: string): boolean =>
	_.includes(['login', 'password'], field);

const memoizedAuthRegex = _.memoize(
	(proxyField: string) => new RegExp(proxyField + '\\s*=\\s*"(.*)"\\s*;'),
);

const memoizedRegex = _.memoize(
	// Add beginning-of-line RegExp to prevent local_ip and local_port static fields from being memoized
	(proxyField) => new RegExp('^\\s*' + proxyField + '\\s*=\\s*([^;\\s]*)\\s*;'),
);

async function readProxy(): Promise<ProxyConfig | undefined> {
	const conf: ProxyConfig = {};
	let redsocksConf: string;
	try {
		redsocksConf = await fs.readFile(redsocksConfPath, 'utf-8');
	} catch (e) {
		if (!ENOENT(e)) {
			throw e;
		}
		return;
	}
	const lines = redsocksConf.split('\n');

	for (const line of lines) {
		for (const proxyField of proxyFields) {
			let match: string[] | null = null;
			if (isAuthField(proxyField)) {
				match = line.match(memoizedAuthRegex(proxyField));
			} else {
				match = line.match(memoizedRegex(proxyField));
			}

			if (match != null) {
				conf[proxyField] = match[1];
			}
		}
	}

	try {
		const noProxy = await fs
			.readFile(noProxyPath, 'utf-8')
			// Prevent empty newline from being reported as a noProxy address
			.then((addrs) => addrs.split('\n').filter((addr) => addr !== ''));

		if (noProxy.length) {
			conf.noProxy = noProxy;
		}
	} catch (e) {
		if (!ENOENT(e)) {
			throw e;
		}
	}

	// Convert port to number per API doc spec
	if (conf.port) {
		conf.port = parseInt(conf.port as string, 10);
	}
	return conf;
}

function generateRedsocksConfEntries(conf: ProxyConfig): string {
	let val = '';
	for (const field of proxyFields) {
		let v = conf[field];
		if (v != null) {
			if (isAuthField(field)) {
				v = `"${v}"`;
			}
			val += `\t${field} = ${v};\n`;
		}
	}
	return val;
}

async function setProxy(maybeConf: ProxyConfig | null): Promise<void> {
	if (_.isEmpty(maybeConf)) {
		await unlinkAll(redsocksConfPath, noProxyPath);
	} else {
		// We know that maybeConf is not null due to the _.isEmpty check above,
		// but the compiler doesn't
		const conf = maybeConf as ProxyConfig;
		await mkdirp(proxyBasePath);
		if (_.isArray(conf.noProxy)) {
			await writeFileAtomic(noProxyPath, conf.noProxy.join('\n'));
		}

		let currentConf: ProxyConfig | undefined;
		try {
			currentConf = await readProxy();
		} catch (err) {
			// Noop - current redsocks.conf does not exist
		}

		// If currentConf is undefined, the currentConf spread will be skipped.
		// See: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#conditional-spreads-create-optional-properties
		const redsocksConf = `
			${redsocksHeader}\n
			${generateRedsocksConfEntries({ ...currentConf, ...conf })}
			${redsocksFooter}
		`;
		await writeFileAtomic(redsocksConfPath, redsocksConf);
	}

	await dbus.restartService('resin-proxy-config');
	await dbus.restartService('redsocks');
}

const hostnamePath = path.join(constants.rootMountPoint, '/etc/hostname');
async function readHostname() {
	console.log('READING HOSTNAME');
	const hostnameData = await fs.readFile(hostnamePath, 'utf-8');
	return _.trim(hostnameData);
}

async function setHostname(val: string) {
	await config.set({ hostname: val });
	await dbus.restartService('resin-hostname');
}

// Don't use async/await here to maintain the bluebird
// promises being returned
export function get(): Bluebird<HostConfig> {
	return Bluebird.join(readProxy(), readHostname(), (proxy, hostname) => {
		return {
			network: {
				proxy,
				hostname,
			},
		};
	});
}

export function patch(conf: HostConfig): Bluebird<void> {
	const promises: Array<Promise<void>> = [];
	if (conf != null && conf.network != null) {
		if (conf.network.proxy != null) {
			promises.push(setProxy(conf.network.proxy));
		}
		if (conf.network.hostname != null) {
			promises.push(setHostname(conf.network.hostname));
		}
	}
	return Bluebird.all(promises).return();
}
