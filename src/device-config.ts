import * as _ from 'lodash';
import { inspect } from 'util';

import * as config from './config';
import * as db from './db';
import * as logger from './logger';
import * as dbus from './lib/dbus';
import { EnvVarObject } from './lib/types';
import { UnitNotLoadedError } from './lib/errors';
import { checkInt, checkTruthy } from './lib/validation';
import log from './lib/supervisor-console';
import { DeviceStatus } from './types/state';
import * as configUtils from './config/utils';
import { SchemaTypeKey } from './config/schema-type';
import { matchesAnyBootConfig } from './config/backends';
import { ConfigBackend } from './config/backends/backend';
import { Odmdata } from './config/backends/odmdata';

const vpnServiceName = 'openvpn';

interface ConfigOption {
	envVarName: string;
	varType: string;
	defaultValue: string;
	rebootRequired?: boolean;
}

// FIXME: Bring this and the deviceState and
// applicationState steps together
export interface ConfigStep {
	// TODO: This is a bit of a mess, the DeviceConfig class shouldn't
	// know that the reboot action exists as it is implemented by
	// DeviceState. Fix this weird circular dependency
	action: keyof DeviceActionExecutors | 'reboot' | 'noop';
	humanReadableTarget?: Dictionary<string>;
	target?: string | Dictionary<string>;
	rebootRequired?: boolean;
}

interface DeviceActionExecutorOpts {
	initial?: boolean;
}

type DeviceActionExecutorFn = (
	step: ConfigStep,
	opts?: DeviceActionExecutorOpts,
) => Promise<void>;

interface DeviceActionExecutors {
	changeConfig: DeviceActionExecutorFn;
	setVPNEnabled: DeviceActionExecutorFn;
	setBootConfig: DeviceActionExecutorFn;
}

let rebootRequired = false;
const actionExecutors: DeviceActionExecutors = {
	changeConfig: async (step) => {
		try {
			if (step.humanReadableTarget) {
				logger.logConfigChange(step.humanReadableTarget);
			}
			if (!_.isObject(step.target)) {
				throw new Error('Non-dictionary value passed to changeConfig');
			}
			// TODO: Change the typing of step so that the types automatically
			// work out and we don't need this cast to any
			await config.set(step.target as { [key in SchemaTypeKey]: any });
			if (step.humanReadableTarget) {
				logger.logConfigChange(step.humanReadableTarget, {
					success: true,
				});
			}
			if (step.rebootRequired) {
				rebootRequired = true;
			}
		} catch (err) {
			if (step.humanReadableTarget) {
				logger.logConfigChange(step.humanReadableTarget, {
					err,
				});
			}
			throw err;
		}
	},
	setVPNEnabled: async (step, opts = {}) => {
		const { initial = false } = opts;
		if (!_.isString(step.target)) {
			throw new Error('Non-string value passed to setVPNEnabled');
		}
		const logValue = { SUPERVISOR_VPN_CONTROL: step.target };
		if (!initial) {
			logger.logConfigChange(logValue);
		}
		try {
			await setVPNEnabled(step.target);
			if (!initial) {
				logger.logConfigChange(logValue, { success: true });
			}
		} catch (err) {
			logger.logConfigChange(logValue, { err });
			throw err;
		}
	},
	setBootConfig: async (step) => {
		if (!_.isObject(step.target)) {
			throw new Error('Non-dictionary passed to DeviceConfig.setBootConfig');
		}
		const backends = await getConfigBackends();
		for (const backend of backends) {
			await setBootConfig(backend, step.target as Dictionary<string>);
		}
	},
};

const configBackends: ConfigBackend[] = [];

const configKeys: Dictionary<ConfigOption> = {
	appUpdatePollInterval: {
		envVarName: 'SUPERVISOR_POLL_INTERVAL',
		varType: 'int',
		defaultValue: '60000',
	},
	instantUpdates: {
		envVarName: 'SUPERVISOR_INSTANT_UPDATE_TRIGGER',
		varType: 'bool',
		defaultValue: 'true',
	},
	localMode: {
		envVarName: 'SUPERVISOR_LOCAL_MODE',
		varType: 'bool',
		defaultValue: 'false',
	},
	connectivityCheckEnabled: {
		envVarName: 'SUPERVISOR_CONNECTIVITY_CHECK',
		varType: 'bool',
		defaultValue: 'true',
	},
	loggingEnabled: {
		envVarName: 'SUPERVISOR_LOG_CONTROL',
		varType: 'bool',
		defaultValue: 'true',
	},
	delta: {
		envVarName: 'SUPERVISOR_DELTA',
		varType: 'bool',
		defaultValue: 'false',
	},
	deltaRequestTimeout: {
		envVarName: 'SUPERVISOR_DELTA_REQUEST_TIMEOUT',
		varType: 'int',
		defaultValue: '30000',
	},
	deltaApplyTimeout: {
		envVarName: 'SUPERVISOR_DELTA_APPLY_TIMEOUT',
		varType: 'int',
		defaultValue: '0',
	},
	deltaRetryCount: {
		envVarName: 'SUPERVISOR_DELTA_RETRY_COUNT',
		varType: 'int',
		defaultValue: '30',
	},
	deltaRetryInterval: {
		envVarName: 'SUPERVISOR_DELTA_RETRY_INTERVAL',
		varType: 'int',
		defaultValue: '10000',
	},
	deltaVersion: {
		envVarName: 'SUPERVISOR_DELTA_VERSION',
		varType: 'int',
		defaultValue: '2',
	},
	lockOverride: {
		envVarName: 'SUPERVISOR_OVERRIDE_LOCK',
		varType: 'bool',
		defaultValue: 'false',
	},
	persistentLogging: {
		envVarName: 'SUPERVISOR_PERSISTENT_LOGGING',
		varType: 'bool',
		defaultValue: 'false',
		rebootRequired: true,
	},
	firewallMode: {
		envVarName: 'HOST_FIREWALL_MODE',
		varType: 'string',
		defaultValue: 'off',
	},
	hostDiscoverability: {
		envVarName: 'HOST_DISCOVERABILITY',
		varType: 'bool',
		defaultValue: 'true',
	},
	hardwareMetrics: {
		envVarName: 'SUPERVISOR_HARDWARE_METRICS',
		varType: 'bool',
		defaultValue: 'true',
	},
	developmentMode: {
		envVarName: 'SUPERVISOR_DEVELOPMENT_MODE',
		varType: 'bool',
		defaultValue: 'false',
	},
};

export const validKeys = [
	'SUPERVISOR_VPN_CONTROL',
	'OVERRIDE_LOCK',
	..._.map(configKeys, 'envVarName'),
];

const rateLimits: Dictionary<{
	duration: number;
	lastAttempt: number | null;
}> = {
	setVPNEnabled: {
		// Only try to switch the VPN once an hour
		duration: 60 * 60 * 1000,
		lastAttempt: null,
	},
};

async function getConfigBackends(): Promise<ConfigBackend[]> {
	// Exit early if we already have a list
	if (configBackends.length > 0) {
		return configBackends;
	}
	// Get all the configurable backends this device supports
	const backends = await configUtils.getSupportedBackends();
	// Initialize each backend
	for (const backend of backends) {
		await backend.initialise();
	}
	// Return list of initialized ConfigBackends
	return backends;
}

export async function setTarget(
	target: Dictionary<string>,
	trx?: db.Transaction,
): Promise<void> {
	const $db = trx ?? db.models.bind(db);

	const formatted = formatConfigKeys(target);
	// check for legacy keys
	if (formatted['OVERRIDE_LOCK'] != null) {
		formatted['SUPERVISOR_OVERRIDE_LOCK'] = formatted['OVERRIDE_LOCK'];
	}

	const confToUpdate = {
		targetValues: JSON.stringify(formatted),
	};

	await $db('deviceConfig').update(confToUpdate);
}

export async function getTarget({
	initial = false,
}: { initial?: boolean } = {}) {
	const [unmanaged, [devConfig]] = await Promise.all([
		config.get('unmanaged'),
		db.models('deviceConfig').select('targetValues'),
	]);

	let conf: Dictionary<string>;
	try {
		conf = JSON.parse(devConfig.targetValues);
	} catch (e) {
		throw new Error(`Corrupted supervisor database! Error: ${e.message}`);
	}
	if (initial || conf.SUPERVISOR_VPN_CONTROL == null) {
		conf.SUPERVISOR_VPN_CONTROL = 'true';
	}
	if (unmanaged && conf.SUPERVISOR_LOCAL_MODE == null) {
		conf.SUPERVISOR_LOCAL_MODE = 'true';
	}

	_.defaults(
		conf,
		_(configKeys).mapKeys('envVarName').mapValues('defaultValue').value(),
	);

	return conf;
}

export async function getCurrent(): Promise<Dictionary<string>> {
	// Build a Dictionary of currently set config values
	const currentConf: Dictionary<string> = {};
	// Get environment variables
	const conf = await config.getMany(
		['deviceType'].concat(_.keys(configKeys)) as SchemaTypeKey[],
	);
	// Add each value
	for (const key of _.keys(configKeys)) {
		const { envVarName } = configKeys[key];
		const confValue = conf[key as SchemaTypeKey];
		currentConf[envVarName] = confValue != null ? confValue.toString() : '';
	}
	// Add VPN information
	currentConf['SUPERVISOR_VPN_CONTROL'] = (await isVPNEnabled())
		? 'true'
		: 'false';
	// Get list of configurable backends
	const backends = await getConfigBackends();
	// Add each backends configurable values
	for (const backend of backends) {
		_.assign(currentConf, await getBootConfig(backend));
	}
	// Return compiled configuration
	return currentConf;
}

export function formatConfigKeys(conf: {
	[key: string]: any;
}): Dictionary<any> {
	const namespaceRegex = /^BALENA_(.*)/;
	const legacyNamespaceRegex = /^RESIN_(.*)/;
	const confFromNamespace = configUtils.filterNamespaceFromConfig(
		namespaceRegex,
		conf,
	);
	const confFromLegacyNamespace = configUtils.filterNamespaceFromConfig(
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

	return _.pickBy(
		confWithoutNamespace,
		(_v, k) => _.includes(validKeys, k) || matchesAnyBootConfig(k),
	);
}

export function getDefaults() {
	return _.extend(
		{
			SUPERVISOR_VPN_CONTROL: 'true',
		},
		_.mapValues(_.mapKeys(configKeys, 'envVarName'), 'defaultValue'),
	);
}

export function resetRateLimits() {
	_.each(rateLimits, (action) => {
		action.lastAttempt = null;
	});
}

export function bootConfigChangeRequired(
	configBackend: ConfigBackend,
	current: Dictionary<string>,
	target: Dictionary<string>,
	deviceType: string,
): boolean {
	const targetBootConfig = configUtils.envToBootConfig(configBackend, target);
	const currentBootConfig = configUtils.envToBootConfig(configBackend, current);

	// Some devices require specific overlays, here we apply them
	configBackend.ensureRequiredConfig(deviceType, targetBootConfig);

	// Search for any unsupported values
	_.each(targetBootConfig, (value, key) => {
		if (
			!configBackend.isSupportedConfig(key) &&
			currentBootConfig[key] !== value
		) {
			const err = `Attempt to change blacklisted config value ${key}`;
			logger.logSystemMessage(err, { error: err }, 'Apply boot config error');
			throw new Error(err);
		}
	});

	if (!_.isEqual(currentBootConfig, targetBootConfig)) {
		// Check if the only difference is the targetBootConfig not containing a special case
		const SPECIAL_CASE = 'configuration'; // ODMDATA Mode for TX2 devices
		if (!(SPECIAL_CASE in targetBootConfig)) {
			// Create a copy to modify
			const targetCopy = _.cloneDeep(targetBootConfig);
			// Add current value to simulate if the value was set in the cloud on provision
			targetCopy[SPECIAL_CASE] = currentBootConfig[SPECIAL_CASE];
			if (_.isEqual(targetCopy, currentBootConfig)) {
				// This proves the only difference is ODMDATA configuration is not set in target config.
				// This special case is to allow devices that upgrade to SV with ODMDATA support
				// and have no set a ODMDATA configuration in the cloud yet.
				// Normally on provision this value would have been sent to the cloud.
				return false; // (no change is required)
			}
		}
		// Change is required because configs do not match
		return true;
	}

	// Return false (no change is required)
	return false;
}

export async function getRequiredSteps(
	currentState: DeviceStatus,
	targetState: { local?: { config?: Dictionary<string> } },
): Promise<ConfigStep[]> {
	const current: Dictionary<string> = _.get(
		currentState,
		['local', 'config'],
		{},
	);
	const target: Dictionary<string> = _.get(
		targetState,
		['local', 'config'],
		{},
	);

	let steps: ConfigStep[] = [];

	const { deviceType, unmanaged } = await config.getMany([
		'deviceType',
		'unmanaged',
	]);

	const configChanges: Dictionary<string> = {};
	const humanReadableConfigChanges: Dictionary<string> = {};
	let reboot = false;

	_.each(
		configKeys,
		(
			{ envVarName, varType, rebootRequired: $rebootRequired, defaultValue },
			key,
		) => {
			let changingValue: null | string = null;
			// Test if the key is different
			if (!configTest(varType, current[envVarName], target[envVarName])) {
				// Check that the difference is not due to the variable having an invalid
				// value set from the cloud
				if (config.valueIsValid(key as SchemaTypeKey, target[envVarName])) {
					// Save the change if it is both valid and different
					changingValue = target[envVarName];
				} else {
					if (!configTest(varType, current[envVarName], defaultValue)) {
						const message = `Warning: Ignoring invalid device configuration value for ${key}, value: ${inspect(
							target[envVarName],
						)}. Falling back to default (${defaultValue})`;
						logger.logSystemMessage(
							message,
							{ key: envVarName, value: target[envVarName] },
							'invalidDeviceConfig',
							false,
						);
						// Set it to the default value if it is different to the current
						changingValue = defaultValue;
					}
				}
				if (changingValue != null) {
					configChanges[key] = changingValue;
					humanReadableConfigChanges[envVarName] = changingValue;
					reboot = $rebootRequired || reboot;
				}
			}
		},
	);

	if (!_.isEmpty(configChanges)) {
		steps.push({
			action: 'changeConfig',
			target: configChanges,
			humanReadableTarget: humanReadableConfigChanges,
			rebootRequired: reboot,
		});
	}

	// Check for special case actions for the VPN
	if (
		!unmanaged &&
		!_.isEmpty(target['SUPERVISOR_VPN_CONTROL']) &&
		checkBoolChanged(current, target, 'SUPERVISOR_VPN_CONTROL')
	) {
		steps.push({
			action: 'setVPNEnabled',
			target: target['SUPERVISOR_VPN_CONTROL'],
		});
	}

	const now = Date.now();
	steps = _.map(steps, (step) => {
		const action = step.action;
		if (action in rateLimits) {
			const lastAttempt = rateLimits[action].lastAttempt;
			rateLimits[action].lastAttempt = now;

			// If this step should be rate limited, we replace it with a noop.
			// We do this instead of removing it, as we don't actually want the
			// state engine to think that it's successfully applied the target state,
			// as it won't reattempt the change until the target state changes
			if (
				lastAttempt != null &&
				Date.now() - lastAttempt < rateLimits[action].duration
			) {
				return { action: 'noop' } as ConfigStep;
			}
		}
		return step;
	});

	const backends = await getConfigBackends();
	// Check for required bootConfig changes
	for (const backend of backends) {
		if (changeRequired(backend, current, target, deviceType)) {
			steps.push({
				action: 'setBootConfig',
				target,
			});
		}
	}

	// Check if there is either no steps, or they are all
	// noops, and we need to reboot. We want to do this
	// because in a preloaded setting with no internet
	// connection, the device will try to start containers
	// before any boot config has been applied, which can
	// cause problems
	if (_.every(steps, { action: 'noop' }) && rebootRequired) {
		steps.push({
			action: 'reboot',
		});
	}

	return steps;
}

function changeRequired(
	configBackend: ConfigBackend,
	currentConfig: Dictionary<string>,
	targetConfig: Dictionary<string>,
	deviceType: string,
): boolean {
	let aChangeIsRequired = false;
	try {
		aChangeIsRequired = bootConfigChangeRequired(
			configBackend,
			currentConfig,
			targetConfig,
			deviceType,
		);
	} catch (e) {
		switch (e) {
			case 'Value missing from target configuration.':
				if (configBackend instanceof Odmdata) {
					// In this special case, devices with ODMDATA support may have
					// empty configuration options in the target if they upgraded to a SV
					// version with ODMDATA support and didn't set a value in the cloud.
					// If this is the case then we will update the cloud with the device's
					// current config and then continue without an error
					aChangeIsRequired = false;
				} else {
					log.debug(`
					The device has a configuration setting that the cloud does not have set.\nNo configurations for this backend will be set.`);
					// Set changeRequired to false so we do not get stuck in a loop trying to fix this mismatch
					aChangeIsRequired = false;
				}
			default:
				throw e;
		}
	}
	return aChangeIsRequired;
}

export function executeStepAction(
	step: ConfigStep,
	opts: DeviceActionExecutorOpts,
) {
	if (step.action !== 'reboot' && step.action !== 'noop') {
		return actionExecutors[step.action](step, opts);
	}
}

export function isValidAction(action: string): boolean {
	return _.includes(_.keys(actionExecutors), action);
}

export async function getBootConfig(
	backend: ConfigBackend | null,
): Promise<EnvVarObject> {
	if (backend == null) {
		return {};
	}
	const conf = await backend.getBootConfig();
	return configUtils.bootConfigToEnv(backend, conf);
}

// Exported for tests
export async function setBootConfig(
	backend: ConfigBackend | null,
	target: Dictionary<string>,
) {
	if (backend == null) {
		return false;
	}

	const conf = configUtils.envToBootConfig(backend, target);
	logger.logSystemMessage(
		`Applying boot config: ${JSON.stringify(conf)}`,
		{},
		'Apply boot config in progress',
	);

	// Ensure the required target config is available
	backend.ensureRequiredConfig(await config.get('deviceType'), conf);

	try {
		await backend.setBootConfig(conf);
		logger.logSystemMessage(
			`Applied boot config: ${JSON.stringify(conf)}`,
			{},
			'Apply boot config success',
		);
		rebootRequired = true;
		return true;
	} catch (err) {
		logger.logSystemMessage(
			`Error setting boot config: ${err}`,
			{ error: err },
			'Apply boot config error',
		);
		throw err;
	}
}

async function isVPNEnabled(): Promise<boolean> {
	try {
		const activeState = await dbus.serviceActiveState(vpnServiceName);
		return !_.includes(['inactive', 'deactivating'], activeState);
	} catch (e) {
		if (UnitNotLoadedError(e)) {
			return false;
		}
		throw e;
	}
}

async function setVPNEnabled(value: string | boolean = true) {
	const enable = checkTruthy(value);
	if (enable) {
		await dbus.startService(vpnServiceName);
	} else {
		await dbus.stopService(vpnServiceName);
	}
}

function configTest(method: string, a: string, b: string): boolean {
	switch (method) {
		case 'bool':
			return checkTruthy(a) === checkTruthy(b);
		case 'int':
			return checkInt(a) === checkInt(b);
		case 'string':
			return a === b;
		default:
			throw new Error('Incorrect datatype passed to DeviceConfig.configTest');
	}
}

function checkBoolChanged(
	current: Dictionary<string>,
	target: Dictionary<string>,
	key: string,
): boolean {
	return checkTruthy(current[key]) !== checkTruthy(target[key]);
}
