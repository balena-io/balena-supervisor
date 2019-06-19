import * as t from 'io-ts';

import * as constants from '../lib/constants';

import {
	NullOrUndefined,
	PermissiveBoolean,
	PermissiveNumber,
	StringJSON,
} from './types';

export const schemaTypes = {
	apiEndpoint: {
		type: t.string,
		default: '',
	},
	apiTimeout: {
		type: PermissiveNumber,
		default: 15 * 60 * 1000,
	},
	listenPort: {
		type: PermissiveNumber,
		default: 48484,
	},
	deltaEndpoint: {
		type: t.string,
		default: 'https://delta.balena-cloud.com',
	},
	uuid: {
		type: t.string,
		default: NullOrUndefined,
	},
	apiKey: {
		type: t.string,
		default: NullOrUndefined,
	},
	deviceApiKey: {
		type: t.string,
		default: '',
	},
	deviceType: {
		type: t.string,
		default: 'unknown',
	},
	username: {
		type: t.string,
		default: NullOrUndefined,
	},
	userId: {
		type: PermissiveNumber,
		default: NullOrUndefined,
	},
	deviceId: {
		type: PermissiveNumber,
		default: NullOrUndefined,
	},
	registered_at: {
		type: PermissiveNumber,
		default: NullOrUndefined,
	},
	applicationId: {
		type: PermissiveNumber,
		default: NullOrUndefined,
	},
	appUpdatePollInterval: {
		type: PermissiveNumber,
		default: 60000,
	},
	instantUpdates: {
		type: PermissiveBoolean,
		default: true,
	},
	mixpanelToken: {
		type: t.string,
		default: constants.defaultMixpanelToken,
	},
	bootstrapRetryDelay: {
		type: PermissiveNumber,
		default: 30000,
	},
	hostname: {
		type: t.string,
		default: NullOrUndefined,
	},
	persistentLogging: {
		type: PermissiveBoolean,
		default: false,
	},
	udevRules: {
		type: t.record(t.string, t.string),
		default: NullOrUndefined,
	},

	// Database types
	apiSecret: {
		type: t.string,
		default: NullOrUndefined,
	},
	name: {
		type: t.string,
		default: 'local',
	},
	initialConfigReported: {
		type: t.string,
		default: '',
	},
	initialConfigSaved: {
		type: PermissiveBoolean,
		default: false,
	},
	containersNormalised: {
		type: PermissiveBoolean,
		default: false,
	},
	loggingEnabled: {
		type: PermissiveBoolean,
		default: true,
	},
	connectivityCheckEnabled: {
		type: PermissiveBoolean,
		default: true,
	},
	delta: {
		type: PermissiveBoolean,
		default: false,
	},
	deltaRequestTimeout: {
		type: PermissiveNumber,
		default: 30000,
	},
	deltaApplyTimeout: {
		type: PermissiveNumber,
		default: 0,
	},
	deltaRetryCount: {
		type: PermissiveNumber,
		default: 30,
	},
	deltaRetryInterval: {
		type: PermissiveNumber,
		default: 10000,
	},
	deltaVersion: {
		type: PermissiveNumber,
		default: 2,
	},
	lockOverride: {
		type: PermissiveBoolean,
		default: false,
	},
	legacyAppsPresent: {
		type: PermissiveBoolean,
		default: false,
	},
	pinDevice: {
		type: new StringJSON<{ app: number; commit: string }>(
			t.interface({ app: t.number, commit: t.string }),
		),
		default: NullOrUndefined,
	},
	currentCommit: {
		type: t.string,
		default: NullOrUndefined,
	},
	targetStateSet: {
		type: PermissiveBoolean,
		default: false,
	},
	localMode: {
		type: PermissiveBoolean,
		default: false,
	},
	udevRulesReported: {
		type: t.string,
		default: NullOrUndefined,
	},

	// Function schema types
	// The type should be the value that the promise resolves
	// to, not including the promise itself
	// The type should be a union of every return type possible,
	// and the default should be t.never always
	version: {
		type: t.string,
		default: t.never,
	},
	currentApiKey: {
		type: t.string,
		default: t.never,
	},
	provisioned: {
		type: t.boolean,
		default: t.never,
	},
	osVersion: {
		type: t.union([t.string, NullOrUndefined]),
		default: t.never,
	},
	osVariant: {
		type: t.union([t.string, NullOrUndefined]),
		default: t.never,
	},
	provisioningOptions: {
		type: t.interface({
			// These types are taken from the types of the individual
			// config values they're made from
			// TODO: It would be nice if we could take the type values
			// from the definitions above and still have the types work
			uuid: t.union([t.string, NullOrUndefined]),
			applicationId: t.union([PermissiveNumber, NullOrUndefined]),
			userId: t.union([PermissiveNumber, NullOrUndefined]),
			deviceType: t.string,
			provisioningApiKey: t.union([t.string, NullOrUndefined]),
			deviceApiKey: t.string,
			apiEndpoint: t.string,
			apiTimeout: PermissiveNumber,
			registered_at: t.union([PermissiveNumber, NullOrUndefined]),
			deviceId: t.union([PermissiveNumber, NullOrUndefined]),
		}),
		default: t.never,
	},
	mixpanelHost: {
		type: t.union([t.null, t.interface({ host: t.string, path: t.string })]),
		default: t.never,
	},
	extendedEnvOptions: {
		type: t.interface({
			uuid: t.union([t.string, NullOrUndefined]),
			listenPort: PermissiveNumber,
			name: t.string,
			apiSecret: t.union([t.string, NullOrUndefined]),
			deviceApiKey: t.string,
			apiEndpoint: t.string,
			version: t.string,
			deviceType: t.string,
			osVersion: t.union([t.string, NullOrUndefined]),
		}),
		default: t.never,
	},
	fetchOptions: {
		type: t.interface({
			uuid: t.union([t.string, NullOrUndefined]),
			currentApiKey: t.string,
			apiEndpoint: t.string,
			deltaEndpoint: t.string,
			delta: PermissiveBoolean,
			deltaRequestTimeout: PermissiveNumber,
			deltaApplyTimeout: PermissiveNumber,
			deltaRetryCount: PermissiveNumber,
			deltaRetryInterval: PermissiveNumber,
			deltaVersion: PermissiveNumber,
		}),
		default: t.never,
	},
	unmanaged: {
		type: t.boolean,
		default: t.never,
	},
};

export type SchemaType = typeof schemaTypes;
export type SchemaTypeKey = keyof SchemaType;

export type RealType<T> = T extends t.Type<any> ? t.TypeOf<T> : T;
export type SchemaReturn<T extends SchemaTypeKey> =
	| t.TypeOf<SchemaType[T]['type']>
	| RealType<SchemaType[T]['default']>;
