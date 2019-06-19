import * as _ from 'lodash';

import { EnvVarObject } from '../lib/types';
import {
	ConfigOptions,
	DeviceConfigBackend,
	ExtlinuxConfigBackend,
	RPiConfigBackend,
} from './backend';

const configBackends = [new ExtlinuxConfigBackend(), new RPiConfigBackend()];

export function isConfigDeviceType(deviceType: string): boolean {
	return getConfigBackend(deviceType) != null;
}

export function getConfigBackend(
	deviceType: string,
): DeviceConfigBackend | undefined {
	return _.find(configBackends, backend => backend.matches(deviceType));
}

export function envToBootConfig(
	configBackend: DeviceConfigBackend | null,
	env: EnvVarObject,
): ConfigOptions {
	if (configBackend == null) {
		return {};
	}

	return _(env)
		.pickBy((_val, key) => configBackend.isBootConfigVar(key))
		.mapKeys((_val, key) => configBackend.processConfigVarName(key))
		.mapValues((val, key) =>
			configBackend.processConfigVarValue(key, val || ''),
		)
		.value();
}

export function bootConfigToEnv(
	configBackend: DeviceConfigBackend,
	config: ConfigOptions,
): EnvVarObject {
	return _(config)
		.mapKeys((_val, key) => configBackend.createConfigVarName(key))
		.mapValues(val => {
			if (_.isArray(val)) {
				return JSON.stringify(val).replace(/^\[(.*)\]$/, '$1');
			}
			return val;
		})
		.value();
}

function filterNamespaceFromConfig(
	namespace: RegExp,
	conf: { [key: string]: any },
): { [key: string]: any } {
	return _.mapKeys(
		_.pickBy(conf, (_v, k) => {
			return namespace.test(k);
		}),
		(_v, k) => {
			return k.replace(namespace, '$1');
		},
	);
}

export function formatConfigKeys(
	configBackend: DeviceConfigBackend | null,
	allowedKeys: string[],
	allowedNamespaces: string[],
	conf: { [key: string]: any },
): { [key: string]: any } {
	const isConfigType = configBackend != null;
	const namespaceRegex = /^BALENA_(.*)/;
	const legacyNamespaceRegex = /^RESIN_(.*)/;
	const confFromNamespace = filterNamespaceFromConfig(namespaceRegex, conf);
	const confFromLegacyNamespace = filterNamespaceFromConfig(
		legacyNamespaceRegex,
		conf,
	);
	const noNamespaceConf = _.pickBy(conf, (_v, k) => {
		return !_.startsWith(k, 'RESIN_') && !_.startsWith(k, 'BALENA_');
	});
	const confWithoutNamespace = _.defaults(
		confFromNamespace,
		confFromLegacyNamespace,
		noNamespaceConf,
	);

	return _.pickBy(confWithoutNamespace, (_v, k) => {
		return (
			_.includes(allowedKeys, k) ||
			(isConfigType && configBackend!.isBootConfigVar(k)) ||
			_.some(allowedNamespaces, n => _.startsWith(k, n))
		);
	});
}
