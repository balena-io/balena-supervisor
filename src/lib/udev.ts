import * as _ from 'lodash';

import Config from '../config';
import { ConfigStep } from '../device-config';

import log from './supervisor-console';

export const UDEV_VAR_NAMESPACE = 'HOST_CONFIG_UDEV';
export const UDEV_SERVICE_NAME = 'os-udevrules';

export async function handleUdevRuleVars(
	config: Config,
	vars: Dictionary<string>,
): Promise<ConfigStep[]> {
	const toMerge = _(vars)
		.mapKeys((_v, k) => k.replace(`${UDEV_VAR_NAMESPACE}_`, ''))
		.pickBy((_v, k) => {
			if (k.length === 0) {
				log.warn('Ignoring invalid namespaced variable');
				return false;
			}
			return true;
		})
		.value();
	let currentConfig = await config.get('udevRules');
	if (currentConfig == null) {
		currentConfig = {};
	}

	const newConfig = _.assign({}, currentConfig, toMerge);

	await config.set({ udevRules: newConfig });

	return !_.isEqual(newConfig, currentConfig)
		? [
				{
					action: 'restartUdevService',
				},
				{
					action: 'reboot',
				},
		  ]
		: [];
}
