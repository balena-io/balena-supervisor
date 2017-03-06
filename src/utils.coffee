Promise = require 'bluebird'
_ = require 'lodash'
fs = Promise.promisifyAll require 'fs'
config = require './config'
knex = require './db'
mixpanel = require 'mixpanel'
networkCheck = require 'network-checker'
blink = require('blinking')(config.ledFile)
url = require 'url'
randomHexString = require './lib/random-hex-string'
{ request } = require './request'
logger = require './lib/logger'
TypedError = require 'typed-error'
execAsync = Promise.promisify(require('child_process').exec)
device = require './device'

# Parses package.json and returns resin-supervisor's version
version = require('../package.json').version
tagExtra = process.env.SUPERVISOR_TAG_EXTRA
version += '+' + tagExtra if !_.isEmpty(tagExtra)
exports.supervisorVersion = version

configJson = require('/boot/config.json')
if Boolean(configJson.supervisorOfflineMode)
	mixpanelClient = mixpanel.init(config.mixpanelToken)
else
	mixpanelClient = { track: _.noop }

exports.mixpanelProperties = mixpanelProperties =
	username: configJson.username

exports.mixpanelTrack = (event, properties = {}) ->
	# Allow passing in an error directly and having it assigned to the error property.
	if properties instanceof Error
		properties = error: properties

	# If the properties has an error argument that is an Error object then it treats it nicely,
	# rather than letting it become `{}`
	if properties.error instanceof Error
		properties.error =
			message: properties.error.message
			stack: properties.error.stack

	properties = _.cloneDeep(properties)

	# Don't log private env vars (e.g. api keys)
	if properties?.app?.env?
		try
			{ env } = properties.app
			env = JSON.parse(env) if _.isString(env)
			safeEnv = _.omit(env, config.privateAppEnvVars)
			properties.app.env = JSON.stringify(safeEnv)
		catch
			properties.app.env = 'Fully hidden due to error in selective hiding'

	console.log('Event:', event, JSON.stringify(properties))
	# Mutation is bad, and it should feel bad
	properties = _.assign(properties, mixpanelProperties)

	mixpanelClient.track(event, properties)

networkPattern =
	blinks: 4
	pause: 1000

exports.blink = blink

pauseConnectivityCheck = false
disableConnectivityCheck = false

# options: An object of net.connect options, with the addition of:
#	timeout: 10s
checkHost = (options) ->
	if disableConnectivityCheck or pauseConnectivityCheck
		return true
	else
		return networkCheck.checkHost(options)

# Custom monitor that uses checkHost function above.
customMonitor = (options, fn) ->
	networkCheck.monitor(checkHost, options, fn)

# pause: A Boolean to pause the connectivity checks
exports.pauseCheck = (pause) ->
	pauseConnectivityCheck = pause

# disable: A Boolean to disable the connectivity checks
exports.disableCheck = disableCheck = (disable) ->
	disableConnectivityCheck = disable

# Call back for inotify triggered when the VPN status is changed.
vpnStatusInotifyCallback = ->
	fs.lstatAsync(config.vpnStatusPath + '/active')
	.then ->
		pauseConnectivityCheck = true
	.catch ->
		pauseConnectivityCheck = false

# Use the following to catch EEXIST errors
EEXIST = (err) -> err.code is 'EEXIST'

exports.connectivityCheck = _.once ->
	parsedUrl = url.parse(config.apiEndpoint)
	fs.mkdirAsync(config.vpnStatusPath)
	.catch EEXIST, (err) ->
		console.log('VPN status path exists.')
	.then ->
		fs.watch(config.vpnStatusPath, vpnStatusInotifyCallback)

	# Manually trigger the call back to detect cases when VPN was switched on before the supervisor starts.
	vpnStatusInotifyCallback()
	customMonitor
		host: parsedUrl.hostname
		port: parsedUrl.port ? (if parsedUrl.protocol is 'https:' then 443 else 80)
		interval: 10 * 1000
		(connected) ->
			if connected
				console.log('Internet Connectivity: OK')
				blink.pattern.stop()
			else
				console.log('Waiting for connectivity...')
				blink.pattern.start(networkPattern)


secretPromises = {}
generateSecret = (name) ->
	Promise.try ->
		return config.forceSecret[name] if config.forceSecret[name]?
		return randomHexString.generate()
	.then (newSecret) ->
		secretInDB = { key: "#{name}Secret", value: newSecret }
		knex('config').update(secretInDB).where(key: "#{name}Secret")
		.then (affectedRows) ->
			knex('config').insert(secretInDB) if affectedRows == 0
		.return(newSecret)

exports.newSecret = (name) ->
	secretPromises[name] ?= Promise.resolve()
	secretPromises[name] = secretPromises[name].then ->
		generateSecret(name)

exports.getOrGenerateSecret = (name) ->
	secretPromises[name] ?= knex('config').select('value').where(key: "#{name}Secret").then ([ secret ]) ->
		return secret.value if secret?
		generateSecret(name)
	return secretPromises[name]

exports.getConfig = getConfig = (key) ->
	knex('config').select('value').where({ key })
	.then ([ conf ]) ->
		return conf?.value

exports.setConfig = (key, value = null) ->
	knex('config').update({ value }).where({ key })
	.then (n) ->
		knex('config').insert({ key, value }) if n == 0

exports.extendEnvVars = (env, uuid, appId, appName, commit) ->
	host = '127.0.0.1'
	newEnv =
		RESIN_APP_ID: appId.toString()
		RESIN_APP_NAME: appName
		RESIN_APP_RELEASE: commit
		RESIN_DEVICE_UUID: uuid
		RESIN_DEVICE_NAME_AT_INIT: getConfig('name')
		RESIN_DEVICE_TYPE: device.getDeviceType()
		RESIN_HOST_OS_VERSION: device.getOSVersion()
		RESIN_SUPERVISOR_ADDRESS: "http://#{host}:#{config.listenPort}"
		RESIN_SUPERVISOR_HOST: host
		RESIN_SUPERVISOR_PORT: config.listenPort
		RESIN_SUPERVISOR_API_KEY: exports.getOrGenerateSecret('api')
		RESIN_SUPERVISOR_VERSION: exports.supervisorVersion
		RESIN_API_KEY: getConfig('apiKey')
		RESIN: '1'
		USER: 'root'
	if env?
		_.defaults(newEnv, env)
	return Promise.props(newEnv)

# Callback function to enable/disable tcp pings
exports.enableConnectivityCheck = (val) ->
	bool = val is 'false'
	disableCheck(bool)
	console.log("Connectivity check enabled: #{not bool}")

# Callback function to enable/disable logs
exports.resinLogControl = (val) ->
	logger.disableLogPublishing(val == 'false')
	console.log('Logs enabled: ' + val)

emptyHostRequest = request.defaults({ headers: Host: '' })
gosuperRequest = (method, endpoint, options = {}, callback) ->
	if _.isFunction(options)
		callback = options
		options = {}
	options.method = method
	options.url = config.gosuperAddress + endpoint
	emptyHostRequest(options, callback)

gosuperPost = _.partial(gosuperRequest, 'POST')
gosuperGet = _.partial(gosuperRequest, 'GET')

exports.gosuper = gosuper =
	post: gosuperPost
	get: gosuperGet
	postAsync: Promise.promisify(gosuperPost, multiArgs: true)
	getAsync: Promise.promisify(gosuperGet, multiArgs: true)

# Callback function to enable/disable VPN
exports.vpnControl = (val) ->
	enable = val != 'false'
	gosuper.postAsync('/v1/vpncontrol', { json: true, body: Enable: enable })
	.spread (response, body) ->
		if response.statusCode == 202
			console.log('VPN enabled: ' + enable)
		else
			console.log('Error: ' + body + ' response:' + response.statusCode)

exports.AppNotFoundError = class AppNotFoundError extends TypedError

exports.getKnexApp = (appId, columns) ->
	knex('app').select(columns).where({ appId })
	.then ([ app ]) ->
		if !app?
			throw new AppNotFoundError('App not found')
		return app

exports.getKnexApps = (columns) ->
	knex('app').select(columns)

exports.getOSVersion = (path) ->
	fs.readFileAsync(path)
	.then (releaseData) ->
		lines = releaseData.toString().split('\n')
		releaseItems = {}
		for line in lines
			[ key, val ] = line.split('=')
			releaseItems[_.trim(key)] = _.trim(val)
		# Remove enclosing quotes: http://stackoverflow.com/a/19156197/2549019
		return releaseItems['PRETTY_NAME'].replace(/^"(.+(?="$))"$/, '$1')
	.catch (err) ->
		console.log('Could not get OS Version: ', err, err.stack)
		return undefined

exports.defaultVolumes = (includeV1Volumes) ->
	volumes = {
		'/data': {}
		'/lib/modules': {}
		'/lib/firmware': {}
		'/host/run/dbus': {}
	}
	if includeV1Volumes
		volumes['/host/var/lib/connman'] = {}
		volumes['/host_run/dbus'] = {}
	return volumes

exports.getDataPath = (identifier) ->
	return config.dataPath + '/' + identifier

exports.defaultBinds = (dataPath, includeV1Binds) ->
	binds = [
		exports.getDataPath(dataPath) + ':/data'
		'/lib/modules:/lib/modules'
		'/lib/firmware:/lib/firmware'
		'/run/dbus:/host/run/dbus'
	]
	if includeV1Binds
		binds.push('/run/dbus:/host_run/dbus')
		binds.push('/var/lib/connman:/host/var/lib/connman')
	return binds

exports.validComposeOptions = [
	'command'
	'entrypoint'
	'environment'
	'expose'
	'image'
	'labels'
	'links'
	'net'
	'network_mode'
	'ports'
	'privileged'
	'restart'
	'stop_signal'
	'user'
	'volumes' # Will be overwritten with the default binds
	'working_dir'
]

exports.validContainerOptions = [
	'Hostname'
	'User'
	'Env'
	'Labels'
	'Cmd'
	'Entrypoint'
	'Image'
	'Volumes'
	'WorkingDir'
	'ExposedPorts'
	'HostConfig'
	'Name'
]

exports.validHostConfigOptions = [
	'Binds' # Will be overwritten with the default binds
	'Links'
	'PortBindings'
	'Privileged'
	'RestartPolicy'
	'NetworkMode'
]

exports.validateKeys = (options, validSet) ->
	Promise.try ->
		return if !options?
		invalidKeys = _.keys(_.omit(options, validSet))
		throw new Error("Using #{invalidKeys.join(', ')} is not allowed.") if !_.isEmpty(invalidKeys)

checkAndAddIptablesRule = (rule) ->
	execAsync("iptables -C #{rule}")
	.catch ->
		execAsync("iptables -A #{rule}")

exports.createIpTablesRules = ->
	allowedInterfaces = ['resin-vpn', 'tun0', 'docker0', 'lo']
	Promise.each allowedInterfaces, (iface) ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -i #{iface} -j ACCEPT")
	.then ->
		checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -j REJECT")
		.catch ->
			# On systems without REJECT support, fall back to DROP
			checkAndAddIptablesRule("INPUT -p tcp --dport #{config.listenPort} -j DROP")
