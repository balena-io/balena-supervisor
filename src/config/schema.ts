export const schema = {
	apiEndpoint: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	apiTimeout: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	listenPort: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	deltaEndpoint: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	uuid: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	apiKey: {
		source: 'config.json',
		mutable: true,
		removeIfNull: true,
	},
	deviceApiKey: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	deviceId: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	registered_at: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	applicationId: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	appUpdatePollInterval: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	mixpanelToken: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	bootstrapRetryDelay: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	hostname: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	persistentLogging: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},
	initialDeviceName: {
		source: 'config.json',
		mutable: false,
		removeIfNull: false,
	},
	developmentMode: {
		source: 'config.json',
		mutable: true,
		removeIfNull: false,
	},

	name: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	initialConfigReported: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	initialConfigSaved: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	containersNormalised: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	loggingEnabled: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	connectivityCheckEnabled: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	delta: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	deltaRequestTimeout: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	deltaApplyTimeout: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	deltaRetryCount: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	deltaRetryInterval: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	deltaVersion: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	lockOverride: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	legacyAppsPresent: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	pinDevice: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	targetStateSet: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	localMode: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	instantUpdates: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	firewallMode: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	hostDiscoverability: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
	hardwareMetrics: {
		source: 'db',
		mutable: true,
		removeIfNull: false,
	},
};

export type Schema = typeof schema;
export type SchemaKey = keyof Schema;
