Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
express = require 'express'
bodyParser = require 'body-parser'
prettyMs = require 'pretty-ms'
hostConfig = require './host-config'
network = require './network'

constants = require './lib/constants'
validation = require './lib/validation'
systemd = require './lib/systemd'
updateLock = require './lib/update-lock'
{ loadTargetFromFile } =  require './device-state/preload'
{ UpdatesLockedError } = require './lib/errors'

{ DeviceConfig } = require './device-config'
ApplicationManager = require './application-manager'

{ log } = require './lib/supervisor-console'
globalEventBus = require './event-bus'

validateLocalState = (state) ->
	if state.name?
		throw new Error('Invalid device name') if not validation.isValidShortText(state.name)
	if !state.apps? or !validation.isValidAppsObject(state.apps)
		throw new Error('Invalid apps')
	if !state.config? or !validation.isValidEnv(state.config)
		throw new Error('Invalid device configuration')

validateDependentState = (state) ->
	if state.apps? and !validation.isValidDependentAppsObject(state.apps)
		throw new Error('Invalid dependent apps')
	if state.devices? and !validation.isValidDependentDevicesObject(state.devices)
		throw new Error('Invalid dependent devices')

validateState = Promise.method (state) ->
	if !_.isObject(state)
		throw new Error('State must be an object')
	if !_.isObject(state.local)
		throw new Error('Local state must be an object')
	validateLocalState(state.local)
	if state.dependent?
		validateDependentState(state.dependent)

# TODO (refactor): This shouldn't be here, and instead should be part of the other
# device api stuff in ./device-api
createDeviceStateRouter = (deviceState) ->
	router = express.Router()
	router.use(bodyParser.urlencoded(limit: '10mb', extended: true))
	router.use(bodyParser.json(limit: '10mb'))

	rebootOrShutdown = (req, res, action) ->
		deviceState.config.get('lockOverride')
		.then (lockOverride) ->
			force = validation.checkTruthy(req.body.force) or lockOverride
			deviceState.executeStepAction({ action }, { force })
		.then (response) ->
			res.status(202).json(response)
		.catch (err) ->
			if err instanceof UpdatesLockedError
				status = 423
			else
				status = 500
			res.status(status).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.post '/v1/reboot', (req, res) ->
		rebootOrShutdown(req, res, 'reboot')

	router.post '/v1/shutdown', (req, res) ->
		rebootOrShutdown(req, res, 'shutdown')

	router.get '/v1/device/host-config', (req, res) ->
		hostConfig.get()
		.then (conf) ->
			res.json(conf)
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.patch '/v1/device/host-config', (req, res) ->
		hostConfig.patch(req.body, deviceState.config)
		.then ->
			res.status(200).send('OK')
		.catch (err) ->
			res.status(503).send(err?.message or err or 'Unknown error')

	router.get '/v1/device', (req, res) ->
		deviceState.getStatus()
		.then (state) ->
			stateToSend = _.pick(state.local, [
				'api_port'
				'ip_address'
				'os_version'
				'supervisor_version'
				'update_pending'
				'update_failed'
				'update_downloaded'
			])
			if state.local.is_on__commit?
				stateToSend.commit = state.local.is_on__commit
			# Will produce nonsensical results for multicontainer apps...
			service = _.toPairs(_.toPairs(state.local.apps)[0]?[1]?.services)[0]?[1]
			if service?
				stateToSend.status = service.status
				# For backwards compatibility, we adapt Running to the old "Idle"
				if stateToSend.status == 'Running'
					stateToSend.status = 'Idle'
				stateToSend.download_progress = service.download_progress
			res.json(stateToSend)
		.catch (err) ->
			res.status(500).json({ Data: '', Error: err?.message or err or 'Unknown error' })

	router.use(deviceState.applications.router)
	return router

module.exports = class DeviceState extends EventEmitter
	constructor: ({ @db, @config, @eventTracker, @logger }) ->
		@deviceConfig = new DeviceConfig({ @db, @config, @logger })
		@applications = new ApplicationManager({ @config, @logger, @db, @eventTracker, deviceState: this })
		@on 'error', (err) ->
			log.error('deviceState error: ', err)
		@_currentVolatile = {}
		@_writeLock = updateLock.writeLock
		@_readLock = updateLock.readLock
		@lastSuccessfulUpdate = null
		@failedUpdates = 0
		@applyInProgress = false
		@applyCancelled = false
		@cancelDelay = null
		@lastApplyStart = process.hrtime()
		@scheduledApply = null
		@shuttingDown = false
		@router = createDeviceStateRouter(this)
		@on 'apply-target-state-end', (err) ->
			if err?
				if not (err instanceof UpdatesLockedError)
					log.error('Device state apply error', err)
			else
				log.success('Device state apply success')
				# We also let the device-config module know that we
				# successfully reached the target state and that it
				# should clear any rate limiting it's applied
				@deviceConfig.resetRateLimits()
		@applications.on('change', @reportCurrentState)

	healthcheck: =>
		@config.getMany([ 'unmanaged' ])
		.then (conf) =>
			cycleTime = process.hrtime(@lastApplyStart)
			cycleTimeMs = cycleTime[0] * 1000 + cycleTime[1] / 1e6
			cycleTimeWithinInterval = cycleTimeMs - @applications.timeSpentFetching < 2 * @maxPollTime
			applyTargetHealthy = conf.unmanaged or !@applyInProgress or @applications.fetchesInProgress > 0 or cycleTimeWithinInterval
			return applyTargetHealthy

	init: ->
		globalEventBus.getInstance().on 'configChanged', (changedConfig) =>
			if changedConfig.loggingEnabled?
				@logger.enable(changedConfig.loggingEnabled)
			if changedConfig.apiSecret?
				@reportCurrentState(api_secret: changedConfig.apiSecret)
			if changedConfig.appUpdatePollInterval?
				@maxPollTime = changedConfig.appUpdatePollInterval

		@config.getMany([
			'initialConfigSaved', 'listenPort', 'apiSecret', 'osVersion', 'osVariant',
			'version', 'provisioned', 'apiEndpoint', 'connectivityCheckEnabled', 'legacyAppsPresent',
			'targetStateSet', 'unmanaged', 'appUpdatePollInterval'
		])
		.then (conf) =>
			@maxPollTime = conf.appUpdatePollInterval
			@applications.init()
			.then =>
				if !conf.initialConfigSaved
					@saveInitialConfig()
			.then =>
				@initNetworkChecks(conf)
				log.info('Reporting initial state, supervisor version and API info')
				@reportCurrentState(
					api_port: conf.listenPort
					api_secret: conf.apiSecret
					os_version: conf.osVersion
					os_variant: conf.osVariant
					supervisor_version: conf.version
					provisioning_progress: null
					provisioning_state: ''
					status: 'Idle'
					logs_channel: null
					update_failed: false
					update_pending: false
					update_downloaded: false
				)
			.then =>
				@applications.getTargetApps()
			.then (targetApps) =>
				if !conf.provisioned or (_.isEmpty(targetApps) and !conf.targetStateSet)
					loadTargetFromFile(null, this)
					.finally =>
						@config.set({ targetStateSet: 'true' })
				else
					log.debug('Skipping preloading')
					if conf.provisioned and !_.isEmpty(targetApps)
						# If we're in this case, it's because we've updated from an older supervisor
						# and we need to mark that the target state has been set so that
						# the supervisor doesn't try to preload again if in the future target
						# apps are empty again (which may happen with multi-app).
						@config.set({ targetStateSet: 'true' })
			.then =>
				@triggerApplyTarget({ initial: true })

	initNetworkChecks: ({ apiEndpoint, connectivityCheckEnabled, unmanaged }) =>
		network.startConnectivityCheck apiEndpoint, connectivityCheckEnabled, (connected) =>
			@connected = connected
		globalEventBus.getInstance().on 'configChanged', (changedConfig) ->
			if changedConfig.connectivityCheckEnabled?
				network.enableConnectivityCheck(changedConfig.connectivityCheckEnabled)
		log.debug('Starting periodic check for IP addresses')
		network.startIPAddressUpdate() (addresses) =>
			@reportCurrentState(
				ip_address: addresses.join(' ')
			)
		, constants.ipAddressUpdateInterval

	saveInitialConfig: =>
		@deviceConfig.getCurrent()
		.then (devConf) =>
			@deviceConfig.setTarget(devConf)
		.then =>
			@config.set({ initialConfigSaved: 'true' })

	emitAsync: (ev, args...) =>
		setImmediate => @emit(ev, args...)

	_readLockTarget: =>
		@_readLock('target').disposer (release) ->
			release()
	_writeLockTarget: =>
		@_writeLock('target').disposer (release) ->
			release()
	_inferStepsLock: =>
		@_writeLock('inferSteps').disposer (release) ->
			release()

	usingReadLockTarget: (fn) =>
		Promise.using @_readLockTarget, -> fn()
	usingWriteLockTarget: (fn) =>
		Promise.using @_writeLockTarget, -> fn()
	usingInferStepsLock: (fn) =>
		Promise.using @_inferStepsLock, -> fn()

	setTarget: (target, localSource = false) ->
		# When we get a new target state, clear any built up apply errors
		# This means that we can attempt to apply the new state instantly
		@failedUpdates = 0

		Promise.join(
			@config.get('apiEndpoint'),
			validateState(target),
			(apiEndpoint) =>
				@usingWriteLockTarget =>
					# Apps, deviceConfig, dependent
					@db.transaction (trx) =>
						Promise.try =>
							@config.set({ name: target.local.name }, trx)
						.then =>
							@deviceConfig.setTarget(target.local.config, trx)
						.then =>
							if localSource or not apiEndpoint
								@applications.setTarget(target.local.apps, target.dependent, 'local', trx)
							else
								@applications.setTarget(target.local.apps, target.dependent, apiEndpoint, trx)
		)

	getTarget: ({ initial = false, intermediate = false } = {}) =>
		@usingReadLockTarget =>
			if intermediate
				return @intermediateTarget
			Promise.props({
				local: Promise.props({
					name: @config.get('name')
					config: @deviceConfig.getTarget({ initial })
					apps: @applications.getTargetApps()
				})
				dependent: @applications.getDependentTargets()
			})

	getStatus: ->
		@applications.getStatus()
		.then (appsStatus) =>
			theState = { local: {}, dependent: {} }
			_.merge(theState.local, @_currentVolatile)
			theState.local.apps = appsStatus.local
			theState.dependent.apps = appsStatus.dependent
			if appsStatus.commit and !@applyInProgress
				theState.local.is_on__commit = appsStatus.commit
			return theState

	getCurrentForComparison: ->
		Promise.join(
			@config.get('name')
			@deviceConfig.getCurrent()
			@applications.getCurrentForComparison()
			@applications.getDependentState()
			(name, devConfig, apps, dependent) ->
				return {
					local: {
						name
						config: devConfig
						apps
					}
					dependent
				}
		)

	reportCurrentState: (newState = {}) =>
		_.assign(@_currentVolatile, newState)
		@emitAsync('change')

	reboot: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Rebooting', {}, 'Reboot')
			systemd.reboot()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	shutdown: (force, skipLock) =>
		@applications.stopAll({ force, skipLock })
		.then =>
			@logger.logSystemMessage('Shutting down', {}, 'Shutdown')
			systemd.shutdown()
		.tap =>
			@shuttingDown = true
			@emitAsync('shutdown')

	executeStepAction: (step, { force, initial, skipLock }) =>
		Promise.try =>
			if @deviceConfig.isValidAction(step.action)
				@deviceConfig.executeStepAction(step, { initial })
			else if _.includes(@applications.validActions, step.action)
				@applications.executeStepAction(step, { force, skipLock })
			else
				switch step.action
					when 'reboot'
						# There isn't really a way that these methods can fail,
						# and if they do, we wouldn't know about it until after
						# the response has been sent back to the API. Just return
						# "OK" for this and the below action
						@reboot(force, skipLock).return(Data: 'OK', Error: null)
					when 'shutdown'
						@shutdown(force, skipLock).return(Data: 'OK', Error: null)
					when 'noop'
						Promise.resolve()
					else
						throw new Error("Invalid action #{step.action}")

	applyStep: (step, { force, initial, intermediate, skipLock }) =>
		if @shuttingDown
			return
		@executeStepAction(step, { force, initial, skipLock })
		.tapCatch (err) =>
			@emitAsync('step-error', err, step)
		.then (stepResult) =>
			@emitAsync('step-completed', null, step, stepResult)

	applyError: (err, { force, initial, intermediate }) =>
		@emitAsync('apply-target-state-error', err)
		@emitAsync('apply-target-state-end', err)
		if intermediate
			throw err
		@failedUpdates += 1
		@reportCurrentState(update_failed: true)
		if @scheduledApply?
			if not (err instanceof UpdatesLockedError)
				log.error("Updating failed, but there's another update scheduled immediately: ", err)
		else
			delay = Math.min((2 ** @failedUpdates) * constants.backoffIncrement, @maxPollTime)
			# If there was an error then schedule another attempt briefly in the future.
			if err instanceof UpdatesLockedError
				message = "Updates are locked, retrying in #{prettyMs(delay, compact: true)}..."
				@logger.logSystemMessage(message, {}, 'updateLocked', false)
				log.info(message)
			else
				log.error("Scheduling another update attempt in #{delay}ms due to failure: ", err)
			@triggerApplyTarget({ force, delay, initial })

	applyTarget: ({ force = false, initial = false, intermediate = false, skipLock = false, nextDelay = 200, retryCount = 0 } = {}) =>
		Promise.try =>
			if !intermediate
				@applyBlocker
		.then =>
			@applications.localModeSwitchCompletion()
		.then =>
			@usingInferStepsLock =>
				Promise.all([
					@getCurrentForComparison()
					@getTarget({ initial, intermediate })
				])
				.then ([ currentState, targetState ]) =>
					@applications.getExtraStateForComparison(currentState, targetState)
					.then (extraState) =>
						@deviceConfig.getRequiredSteps(currentState, targetState)
						.then (deviceConfigSteps) =>
							noConfigSteps = _.every(deviceConfigSteps, ({ action }) -> action is 'noop')
							if not noConfigSteps
								return [false, deviceConfigSteps]
							else
								@applications.getRequiredSteps(currentState, targetState, extraState, intermediate)
								.then (appSteps) ->
									# We need to forward to no-ops to the next step if the application state is done
									# The true and false values below represent whether we should add an exponential
									# backoff if the steps are all no-ops. the reason that this has to be different
									# is that a noop step from the application manager means that we should keep running
									# in a tight loop, waiting for an image to download (for example). The device-config
									# steps generally have a much higher time to wait before the no-ops will stop, so we
									# should try to reduce the effect that this will have
									if _.isEmpty(appSteps) and noConfigSteps
										return [true, deviceConfigSteps]
									return [false, appSteps]
		.then ([backoff, steps]) =>
			if _.isEmpty(steps)
				@emitAsync('apply-target-state-end', null)
				if !intermediate
					log.debug('Finished applying target state')
					@applications.timeSpentFetching = 0
					@failedUpdates = 0
					@lastSuccessfulUpdate = Date.now()
					@reportCurrentState(update_failed: false, update_pending: false, update_downloaded: false)
				return
			if !intermediate
				@reportCurrentState(update_pending: true)
			if _.every(steps, (step) -> step.action == 'noop')
				if backoff
					retryCount += 1
					# Backoff to a maximum of 10 minutes
					nextDelay = Math.min(2 ** retryCount * 1000, 60 * 10 * 1000)
				else
					nextDelay = 1000
			Promise.map steps, (step) =>
				@applyStep(step, { force, initial, intermediate, skipLock })
			.delay(nextDelay)
			.then =>
				@applyTarget({ force, initial, intermediate, skipLock, nextDelay, retryCount })
			.catch (err) =>
				detailedError = new Error('Failed to apply state transition steps. ' + err.message + ' Steps:' + JSON.stringify(_.map(steps, 'action')))
				@applyError(detailedError, { force, initial, intermediate })
		.catch (err) =>
			@applyError(err, { force, initial, intermediate })

	pausingApply: (fn) =>
		lock = =>
			@_writeLock('pause').disposer (release) ->
				release()
		pause = =>
			Promise.try =>
				res = null
				@applyBlocker = new Promise (resolve) ->
					res = resolve
				return res
			.disposer (resolve) ->
				resolve()

		Promise.using lock(), ->
			Promise.using pause(), ->
				fn()

	resumeNextApply: =>
		@applyUnblocker?()
		return

	triggerApplyTarget: ({ force = false, delay = 0, initial = false, isFromApi = false } = {}) =>
		if @applyInProgress
			if !@scheduledApply? || (isFromApi && @cancelDelay)
				@scheduledApply = { force, delay }
				if isFromApi
					# Cancel promise delay if call came from api to
					# prevent waiting due to backoff (and if we've
					# previously setup a delay)
					@cancelDelay?()
			else
				# If a delay has been set it's because we need to hold off before applying again,
				# so we need to respect the maximum delay that has been passed
				@scheduledApply.delay = Math.max(delay, @scheduledApply.delay)
				@scheduledApply.force or= force
			return
		@applyCancelled = false
		@applyInProgress = true
		new Promise (resolve, reject) =>
			setTimeout(resolve, delay)
			@cancelDelay = reject
		.catch =>
			@applyCancelled = true
		.then =>
			@cancelDelay = null
			if @applyCancelled
				log.info('Skipping applyTarget because of a cancellation')
				return
			@lastApplyStart = process.hrtime()
			log.info('Applying target state')
			@applyTarget({ force, initial })
		.finally =>
			@applyInProgress = false
			@reportCurrentState()
			if @scheduledApply?
				@triggerApplyTarget(@scheduledApply)
				@scheduledApply = null
		return null

	applyIntermediateTarget: (intermediateTarget, { force = false, skipLock = false } = {}) =>
		@intermediateTarget = _.cloneDeep(intermediateTarget)
		@applyTarget({ intermediate: true, force, skipLock })
		.then =>
			@intermediateTarget = null
