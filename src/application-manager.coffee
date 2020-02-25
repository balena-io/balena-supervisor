Promise = require 'bluebird'
_ = require 'lodash'
EventEmitter = require 'events'
express = require 'express'
bodyParser = require 'body-parser'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'

constants = require './lib/constants'
{ log } = require './lib/supervisor-console'

{ validateTargetContracts } = require './lib/contracts'
{ DockerUtils: Docker } = require './lib/docker-utils'
{ LocalModeManager } = require './local-mode'
updateLock = require './lib/update-lock'
{ checkTruthy, checkInt, checkString } = require './lib/validation'
{ ContractViolationError, NotFoundError } = require './lib/errors'
{ pathExistsOnHost } = require './lib/fs-utils'

{ TargetStateAccessor } = require './target-state'

{ ServiceManager } = require './compose/service-manager'
{ Service } = require './compose/service'
{ Images } = require './compose/images'
{ NetworkManager } = require './compose/network-manager'
{ Network } = require './compose/network'
{ VolumeManager } = require './compose/volume-manager'
{ Volume } = require './compose/volume'
compositionSteps = require './compose/composition-steps'

Proxyvisor = require './proxyvisor'

{ createV1Api } = require './device-api/v1'
{ createV2Api } = require './device-api/v2'
{ serviceAction } = require './device-api/common'

# TODO: move this to an Image class?
imageForService = (service) ->
	return {
		name: service.imageName
		appId: service.appId
		serviceId: service.serviceId
		serviceName: service.serviceName
		imageId: service.imageId
		releaseId: service.releaseId
		dependent: 0
	}

fetchAction = (service) ->
	return {
		action: 'fetch'
		image: imageForService(service)
		serviceId: service.serviceId
		serviceName: service.serviceName
	}

# TODO: implement additional v2 endpoints
# Some v1 endpoins only work for single-container apps as they assume the app has a single service.
createApplicationManagerRouter = (applications) ->
	router = express.Router()
	router.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }))
	router.use(bodyParser.json({ limit: '10mb' }))

	createV1Api(router, applications)
	createV2Api(router, applications)

	router.use(applications.proxyvisor.router)

	return router

module.exports = class ApplicationManager extends EventEmitter
	constructor: ({ @logger, @config, @db, @eventTracker, @deviceState }) ->
		@docker = new Docker()
		@images = new Images({ @docker, @logger, @db, @config })
		@services = new ServiceManager({ @docker, @logger, @images, @config })
		@networks = new NetworkManager({ @docker, @logger })
		@volumes = new VolumeManager({ @docker, @logger })
		@proxyvisor = new Proxyvisor({ @config, @logger, @db, @docker, @images, applications: this })
		@localModeManager = new LocalModeManager(@config, @docker, @logger, @db)
		@timeSpentFetching = 0
		@fetchesInProgress = 0
		# @_targetVolatilePerImageId keeps volatile parts of the target state, indexed by imageId. This is useful when executing
		# changes in the target state that should not persist across reboots, e.g. when stopping a container from a supervisor API action.
		@_targetVolatilePerImageId = {}
		# @_containerStarted is indexed by containerId and keeps track of the containers that have already been started, to avoid
		# triggering consecutive start actions for the same container.
		@_containerStarted = {}

		@targetStateWrapper = new TargetStateAccessor(this, @config, @db)

		@config.on 'change', (changedConfig) =>
			if changedConfig.appUpdatePollInterval
				@images.appUpdatePollInterval = changedConfig.appUpdatePollInterval

		@actionExecutors = compositionSteps.getExecutors({
			lockFn: @_lockingIfNecessary,
			services: @services,
			networks: @networks,
			volumes: @volumes,
			applications: this,
			images: @images,
			config: @config,
			callbacks: {
				containerStarted: (id) =>
					@_containerStarted[id] = true
				containerKilled: (id) =>
					delete @_containerStarted[id]
				fetchStart: =>
					@fetchesInProgress += 1
				fetchEnd: =>
					@fetchesInProgress -= 1
				fetchTime: (time) =>
					@timeSpentFetching += time
				stateReport: (state) =>
					@reportCurrentState(state)
				bestDeltaSource: @bestDeltaSource
			}
		})
		@validActions = _.keys(@actionExecutors).concat(@proxyvisor.validActions)
		@router = createApplicationManagerRouter(this)
		@images.on('change', @reportCurrentState)
		@services.on('change', @reportCurrentState)

	serviceAction: serviceAction
	imageForService: imageForService
	fetchAction: fetchAction

	reportCurrentState: (data) =>
		@emit('change', data)

	init: =>
		@config.get('appUpdatePollInterval')
		.then (interval) =>
			@images.appUpdatePollInterval = interval
			@images.cleanupDatabase()
		.then =>

			cleanup = =>
				@docker.listContainers(all: true).then (containers) =>
					@logger.clearOutOfDateDBLogs(_.map(containers, 'Id'))
			# Rather than relying on removing out of date database entries when we're no
			# longer using them, set a task that runs periodically to clear out the database
			# This has the advantage that if for some reason a container is removed while the
			# supervisor is down, we won't have zombie entries in the db

			# Once a day
			setInterval(cleanup, 1000 * 60 * 60 * 24)
			# But also run it in on startup
			cleanup()
		.then =>
			@localModeManager.init()
		.then =>
			@services.attachToRunning()
		.then =>
			@services.listenToEvents()

	# Returns the status of applications and their services
	getStatus: =>
		@config.get('localMode').then (localMode) =>
			@_getStatus(localMode)

	_getStatus: (localMode) =>
		Promise.join(
			@services.getStatus()
			@images.getStatus(localMode)
			@config.get('currentCommit')
			(services, images, currentCommit) ->
				apps = {}
				dependent = {}
				releaseId = null
				creationTimesAndReleases = {}
				# We iterate over the current running services and add them to the current state
				# of the app they belong to.
				for service in services
					appId = service.appId
					apps[appId] ?= {}
					creationTimesAndReleases[appId] = {}
					apps[appId].services ?= {}
					# We only send commit if all services have the same release, and it matches the target release
					if !releaseId?
						releaseId = service.releaseId
					else if releaseId != service.releaseId
						releaseId = false
					if !apps[appId].services[service.imageId]?
						apps[appId].services[service.imageId] = _.pick(service, [ 'status', 'releaseId' ])
						creationTimesAndReleases[appId][service.imageId] = _.pick(service, [ 'createdAt', 'releaseId' ])
						apps[appId].services[service.imageId].download_progress = null
					else
						# There's two containers with the same imageId, so this has to be a handover
						apps[appId].services[service.imageId].releaseId = _.minBy([ creationTimesAndReleases[appId][service.imageId], service ], 'createdAt').releaseId
						apps[appId].services[service.imageId].status = 'Handing over'

				for image in images
					appId = image.appId
					if !image.dependent
						apps[appId] ?= {}
						apps[appId].services ?= {}
						if !apps[appId].services[image.imageId]?
							apps[appId].services[image.imageId] = _.pick(image, [ 'status', 'releaseId' ])
							apps[appId].services[image.imageId].download_progress = image.downloadProgress
					else if image.imageId?
						dependent[appId] ?= {}
						dependent[appId].images ?= {}
						dependent[appId].images[image.imageId] = _.pick(image, [ 'status' ])
						dependent[appId].images[image.imageId].download_progress = image.downloadProgress
					else
						log.debug('Ignoring legacy dependent image', image)

				obj = { local: apps, dependent }
				obj.commit = currentCommit
				return obj
		)

	getDependentState: =>
		@proxyvisor.getCurrentStates()

	_buildApps: (services, networks, volumes, currentCommit) ->
		apps = {}

		# We iterate over the current running services and add them to the current state
		# of the app they belong to.
		for service in services
			appId = service.appId
			apps[appId] ?= { appId, services: [], volumes: {}, networks: {} }
			apps[appId].services.push(service)

		for network in networks
			appId = network.appId
			apps[appId] ?= { appId, services: [], volumes: {}, networks: {} }
			apps[appId].networks[network.name] = network

		for volume in volumes
			appId = volume.appId
			apps[appId] ?= { appId, services: [], volumes: {}, networks: {} }
			apps[appId].volumes[volume.name] = volume

		# multi-app warning!
		# This is just wrong on every level
		_.each apps, (app) ->
			app.commit = currentCommit

		return apps

	getCurrentForComparison: =>
		Promise.join(
			@services.getAll()
			@networks.getAll()
			@volumes.getAll()
			@config.get('currentCommit')
			@_buildApps
		)

	getCurrentApp: (appId) =>
		Promise.join(
			@services.getAllByAppId(appId)
			@networks.getAllByAppId(appId)
			@volumes.getAllByAppId(appId)
			@config.get('currentCommit')
			@_buildApps
		).get(appId)

	getTargetApp: (appId) =>
		@targetStateWrapper.getTargetApp(appId).then (app) =>
			if !app?
				return
			@normaliseAndExtendAppFromDB(app)

	# Compares current and target services and returns a list of service pairs to be updated/removed/installed.
	# The returned list is an array of objects where the "current" and "target" properties define the update pair, and either can be null
	# (in the case of an install or removal).
	compareServicesForUpdate: (currentServices, targetServices, containerIds) =>
		removePairs = []
		installPairs = []
		updatePairs = []
		targetServiceIds = _.map(targetServices, 'serviceId')
		currentServiceIds = _.uniq(_.map(currentServices, 'serviceId'))

		toBeRemoved = _.difference(currentServiceIds, targetServiceIds)
		for serviceId in toBeRemoved
			servicesToRemove = _.filter(currentServices, { serviceId })
			for service in servicesToRemove
				removePairs.push({
					current: service
					target: null
					serviceId
				})

		toBeInstalled = _.difference(targetServiceIds, currentServiceIds)
		for serviceId in toBeInstalled
			serviceToInstall = _.find(targetServices, { serviceId })
			if serviceToInstall?
				installPairs.push({
					current: null
					target: serviceToInstall
					serviceId
				})

		toBeMaybeUpdated = _.intersection(targetServiceIds, currentServiceIds)
		currentServicesPerId = {}
		targetServicesPerId = _.keyBy(targetServices, 'serviceId')
		for serviceId in toBeMaybeUpdated
			currentServiceContainers = _.filter(currentServices, { serviceId })
			if currentServiceContainers.length > 1
				currentServicesPerId[serviceId] = _.maxBy(currentServiceContainers, 'createdAt')

				# All but the latest container for this service are spurious and should be removed
				for service in _.without(currentServiceContainers, currentServicesPerId[serviceId])
					removePairs.push({
						current: service
						target: null
						serviceId
					})
			else
				currentServicesPerId[serviceId] = currentServiceContainers[0]

		# Returns true if a service matches its target except it should be running and it is not, but we've
		# already started it before. In this case it means it just exited so we don't want to start it again.
		alreadyStarted = (serviceId) =>
			return (
				currentServicesPerId[serviceId].isEqualExceptForRunningState(targetServicesPerId[serviceId], containerIds) and
				targetServicesPerId[serviceId].config.running  and
				@_containerStarted[currentServicesPerId[serviceId].containerId]
			)

		needUpdate = _.filter toBeMaybeUpdated, (serviceId) ->
			!currentServicesPerId[serviceId].isEqual(targetServicesPerId[serviceId], containerIds) and !alreadyStarted(serviceId)

		for serviceId in needUpdate
			updatePairs.push({
				current: currentServicesPerId[serviceId]
				target: targetServicesPerId[serviceId]
				serviceId
			})

		return { removePairs, installPairs, updatePairs }

	_compareNetworksOrVolumesForUpdate: (model, { current, target }, appId) ->
		outputPairs = []
		currentNames = _.keys(current)
		targetNames = _.keys(target)

		toBeRemoved = _.difference(currentNames, targetNames)
		for name in toBeRemoved
			outputPairs.push({ current: current[name], target: null })

		toBeInstalled = _.difference(targetNames, currentNames)
		for name in toBeInstalled
			outputPairs.push({ current: null, target: target[name] })

		toBeUpdated = _.filter _.intersection(targetNames, currentNames), (name) ->
			return !current[name].isEqualConfig(target[name])
		for name in toBeUpdated
			outputPairs.push({
				current: current[name],
				target: target[name]
			})

		return outputPairs

	compareNetworksForUpdate: ({ current, target }, appId) =>
		@_compareNetworksOrVolumesForUpdate(@networks, { current, target }, appId)

	compareVolumesForUpdate: ({ current, target }, appId) =>
		@_compareNetworksOrVolumesForUpdate(@volumes, { current, target }, appId)

	# Checks if a service is using a network or volume that is about to be updated
	_hasCurrentNetworksOrVolumes: (service, networkPairs, volumePairs) ->
		if !service?
			return false
		hasNetwork = _.some networkPairs, (pair) ->
			"#{service.appId}_#{pair.current?.name}" == service.networkMode
		if hasNetwork
			return true
		hasVolume = _.some service.volumes, (volume) ->
			name = _.split(volume, ':')[0]
			_.some volumePairs, (pair) ->
				"#{service.appId}_#{pair.current?.name}" == name
		return hasVolume

	# TODO: account for volumes-from, networks-from, links, etc
	# TODO: support networks instead of only networkMode
	_dependenciesMetForServiceStart: (target, networkPairs, volumePairs, pendingPairs) ->
		# for dependsOn, check no install or update pairs have that service
		dependencyUnmet = _.some target.dependsOn, (dependency) ->
			_.some(pendingPairs, (pair) -> pair.target?.serviceName == dependency)
		if dependencyUnmet
			return false
		# for networks and volumes, check no network pairs have that volume name
		if _.some(networkPairs, (pair) -> "#{target.appId}_#{pair.target?.name}" == target.networkMode)
			return false
		volumeUnmet = _.some target.volumes, (volumeDefinition) ->
			[ sourceName, destName ] = volumeDefinition.split(':')
			if !destName? # If this is not a named volume, ignore it
				return false
			return _.some(volumePairs, (pair) -> "#{target.appId}_#{pair.target?.name}" == sourceName)
		return !volumeUnmet

	# Unless the update strategy requires an early kill (i.e. kill-then-download, delete-then-download), we only want
	# to kill a service once the images for the services it depends on have been downloaded, so as to minimize
	# downtime (but not block the killing too much, potentially causing a deadlock)
	_dependenciesMetForServiceKill: (target, targetApp, availableImages, localMode) ->
		# Because we only check for an image being available, in local mode this will always
		# be the case, so return true regardless. If this function ever checks for anything else,
		# we'll need to change the logic here
		if localMode
			return true
		if target.dependsOn?
			for dependency in target.dependsOn
				dependencyService = _.find(targetApp.services, serviceName: dependency)
				if !_.some(availableImages, (image) -> image.dockerImageId == dependencyService.image or Images.isSameImage(image, { name: dependencyService.imageName }))
					return false
		return true

	_nextStepsForNetworkOrVolume: ({ current, target }, currentApp, changingPairs, dependencyComparisonFn, model) ->
		# Check none of the currentApp.services use this network or volume
		if current?
			dependencies = _.filter currentApp.services, (service) ->
				dependencyComparisonFn(service, current)
			if _.isEmpty(dependencies)
				if model is 'network'
					return [{ action: 'removeNetwork', current }]
				return []
			else
				# If the current update doesn't require killing the services that use this network/volume,
				# we have to kill them before removing the network/volume (e.g. when we're only updating the network config)
				steps = []
				for dependency in dependencies
					if dependency.status != 'Stopping' and !_.some(changingPairs, serviceId: dependency.serviceId)
						steps.push(serviceAction('kill', dependency.serviceId, dependency))
				return steps
		else if target?
			action = if model is 'network' then 'createNetwork' else 'createVolume'
			return [{ action, target }]

	_nextStepsForNetwork: ({ current, target }, currentApp, changingPairs) =>
		dependencyComparisonFn = (service, current) ->
			service.config.networkMode == "#{service.appId}_#{current?.name}"

		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, 'network')

	_nextStepsForVolume: ({ current, target }, currentApp, changingPairs) ->
		# Check none of the currentApp.services use this network or volume
		dependencyComparisonFn = (service, current) ->
			_.some service.config.volumes, (volumeDefinition) ->
				[ sourceName, destName ] = volumeDefinition.split(':')
				destName? and sourceName == "#{service.appId}_#{current?.name}"
		@_nextStepsForNetworkOrVolume({ current, target }, currentApp, changingPairs, dependencyComparisonFn, 'volume')

	# Infers steps that do not require creating a new container
	_updateContainerStep: (current, target) ->
		if current.releaseId != target.releaseId or current.imageId != target.imageId
			return serviceAction('updateMetadata', target.serviceId, current, target)
		else if target.config.running
			return serviceAction('start', target.serviceId, current, target)
		else
			return serviceAction('stop', target.serviceId, current, target)

	_fetchOrStartStep: (current, target, needsDownload, dependenciesMetForStart) ->
		if needsDownload
			return fetchAction(target)
		else if dependenciesMetForStart()
			return serviceAction('start', target.serviceId, current, target)
		else
			return null

	_strategySteps: {
		'download-then-kill': (current, target, needsDownload, dependenciesMetForStart, dependenciesMetForKill) ->
			if needsDownload
				return fetchAction(target)
			else if dependenciesMetForKill()
				# We only kill when dependencies are already met, so that we minimize downtime
				return serviceAction('kill', target.serviceId, current, target)
			else
				return { action: 'noop' }
		'kill-then-download': (current, target) ->
			return serviceAction('kill', target.serviceId, current, target)
		'delete-then-download': (current, target) ->
			return serviceAction('kill', target.serviceId, current, target)
		'hand-over': (current, target, needsDownload, dependenciesMetForStart, dependenciesMetForKill, needsSpecialKill, timeout) ->
			if needsDownload
				return fetchAction(target)
			else if needsSpecialKill and dependenciesMetForKill()
				return serviceAction('kill', target.serviceId, current, target)
			else if dependenciesMetForStart()
				return serviceAction('handover', target.serviceId, current, target, timeout: timeout)
			else
				return { action: 'noop' }
	}

	_nextStepForService: ({ current, target }, updateContext, localMode, containerIds) =>
		{ targetApp, networkPairs, volumePairs, installPairs, updatePairs, availableImages, downloading } = updateContext
		if current?.status == 'Stopping'
			# There is already a kill step in progress for this service, so we wait
			return { action: 'noop' }

		if current?.status == 'Dead'
			# Dead containers have to be removed
			return serviceAction('remove', current.serviceId, current)

		needsDownload = false
		# Don't attempt to fetch any images in local mode, they should already be there
		if !localMode
			needsDownload = !_.some availableImages, (image) ->
				image.dockerImageId == target?.config.image or Images.isSameImage(image, { name: target.imageName })

		# This service needs an image download but it's currently downloading, so we wait
		if needsDownload and target?.imageId in downloading
			return { action: 'noop' }

		dependenciesMetForStart = =>
			@_dependenciesMetForServiceStart(target, networkPairs, volumePairs, installPairs.concat(updatePairs))
		dependenciesMetForKill = =>
			!needsDownload and @_dependenciesMetForServiceKill(target, targetApp, availableImages, localMode)

		# If the service is using a network or volume that is being updated, we need to kill it
		# even if its strategy is handover
		needsSpecialKill = @_hasCurrentNetworksOrVolumes(current, networkPairs, volumePairs)

		if current?.isEqualConfig(target, containerIds)
			# We're only stopping/starting it
			return @_updateContainerStep(current, target)
		else if !current?
			# Either this is a new service, or the current one has already been killed
			return @_fetchOrStartStep(current, target, needsDownload, dependenciesMetForStart)
		else
			strategy = checkString(target.config.labels['io.balena.update.strategy'])
			validStrategies = [ 'download-then-kill', 'kill-then-download', 'delete-then-download', 'hand-over' ]
			if !_.includes(validStrategies, strategy)
				strategy = 'download-then-kill'
			timeout = checkInt(target.config.labels['io.balena.update.handover-timeout'])
			return @_strategySteps[strategy](current, target, needsDownload, dependenciesMetForStart, dependenciesMetForKill, needsSpecialKill, timeout)

	_nextStepsForAppUpdate: (currentApp, targetApp, localMode, containerIds, availableImages = [], downloading = []) =>
		emptyApp = { services: [], volumes: {}, networks: {} }
		if !targetApp?
			targetApp = emptyApp
		else
			# Create the default network for the target app
			targetApp.networks['default'] ?= @createTargetNetwork('default', targetApp.appId, {})
		currentApp ?= emptyApp
		if currentApp.services?.length == 1 and targetApp.services?.length == 1 and
			targetApp.services[0].serviceName == currentApp.services[0].serviceName and
			checkTruthy(currentApp.services[0].config.labels['io.balena.legacy-container'])
				# This is a legacy preloaded app or container, so we didn't have things like serviceId.
				# We hack a few things to avoid an unnecessary restart of the preloaded app
				# (but ensuring it gets updated if it actually changed)
				targetApp.services[0].config.labels['io.balena.legacy-container'] = currentApp.services[0].config.labels['io.balena.legacy-container']
				targetApp.services[0].config.labels['io.balena.service-id'] = currentApp.services[0].config.labels['io.balena.service-id']
				targetApp.services[0].serviceId = currentApp.services[0].serviceId

		appId = targetApp.appId ? currentApp.appId
		networkPairs = @compareNetworksForUpdate({ current: currentApp.networks, target: targetApp.networks }, appId)
		volumePairs = @compareVolumesForUpdate({ current: currentApp.volumes, target: targetApp.volumes }, appId)
		{ removePairs, installPairs, updatePairs } = @compareServicesForUpdate(currentApp.services, targetApp.services, containerIds)
		steps = []
		# All removePairs get a 'kill' action
		for pair in removePairs
			if pair.current.status != 'Stopping'
				steps.push(serviceAction('kill', pair.current.serviceId, pair.current, null))
			else
				steps.push({ action: 'noop' })

		# next step for install pairs in download - start order, but start requires dependencies, networks and volumes met
		# next step for update pairs in order by update strategy. start requires dependencies, networks and volumes met.
		for pair in installPairs.concat(updatePairs)
			step = @_nextStepForService(pair, { targetApp, networkPairs, volumePairs, installPairs, updatePairs, availableImages, downloading }, localMode, containerIds)
			if step?
				steps.push(step)
		# next step for network pairs - remove requires services killed, create kill if no pairs or steps affect that service
		for pair in networkPairs
			pairSteps = @_nextStepsForNetwork(pair, currentApp, removePairs.concat(updatePairs))
			steps = steps.concat(pairSteps)
		# next step for volume pairs - remove requires services killed, create kill if no pairs or steps affect that service
		for pair in volumePairs
			pairSteps = @_nextStepsForVolume(pair, currentApp, removePairs.concat(updatePairs))
			steps = steps.concat(pairSteps)

		if _.isEmpty(steps) and targetApp.commit? and currentApp.commit != targetApp.commit
			steps.push({
				action: 'updateCommit'
				target: targetApp.commit
			})

		return _.map(steps, (step) -> _.assign({}, step, { appId }))

	normaliseAppForDB: (app) =>
		services = _.map app.services, (s, serviceId) ->
			service = _.clone(s)
			service.appId = app.appId
			service.releaseId = app.releaseId
			service.serviceId = checkInt(serviceId)
			service.commit = app.commit
			return service
		Promise.map services, (service) =>
			service.image = @images.normalise(service.image)
			Promise.props(service)
		.then (services) ->
			dbApp = {
				appId: app.appId
				commit: app.commit
				name: app.name
				source: app.source
				releaseId: app.releaseId
				services: JSON.stringify(services)
				networks: JSON.stringify(app.networks ? {})
				volumes: JSON.stringify(app.volumes ? {})
			}
			return dbApp

	createTargetService: (service, opts) ->
		# The image class now returns a native promise, so wrap
		# this in a bluebird promise until we convert this to typescript
		Promise.resolve(@images.inspectByName(service.image))
		.catchReturn(NotFoundError, undefined)
		.then (imageInfo) ->
			serviceOpts = {
				serviceName: service.serviceName
				imageInfo
			}
			_.assign(serviceOpts, opts)
			service.imageName = service.image
			if imageInfo?.Id?
				service.image = imageInfo.Id
			return Service.fromComposeObject(service, serviceOpts)

	createTargetVolume: (name, appId, volume) ->
		return Volume.fromComposeObject(
			name,
			appId,
			volume,
			{ @docker, @logger }
		)

	createTargetNetwork: (name, appId, network) ->
		return Network.fromComposeObject(
			name,
			appId,
			network
			{ @docker, @logger },
		)

	normaliseAndExtendAppFromDB: (app) =>
		Promise.join(
			@config.get('extendedEnvOptions')
			@docker.getNetworkGateway(constants.supervisorNetworkInterface).catch(-> '127.0.0.1')
			Promise.props({
				firmware: pathExistsOnHost('/lib/firmware')
				modules: pathExistsOnHost('/lib/modules')
			})
			fs.readFileAsync(path.join(constants.rootMountPoint, '/etc/hostname'), 'utf8').then(_.trim)
			(opts, supervisorApiHost, hostPathExists, hostnameOnHost) =>
				configOpts = {
					appName: app.name
					supervisorApiHost
					hostPathExists
					hostnameOnHost
				}
				_.assign(configOpts, opts)

				volumes = JSON.parse(app.volumes)
				volumes = _.mapValues volumes, (volumeConfig, volumeName) =>
					volumeConfig ?= {}
					volumeConfig.labels ?= {}
					@createTargetVolume(volumeName, app.appId, volumeConfig)

				networks = JSON.parse(app.networks)
				networks = _.mapValues networks, (networkConfig, networkName) =>
					networkConfig ?= {}
					@createTargetNetwork(networkName, app.appId, networkConfig)

				Promise.map(JSON.parse(app.services), (service) => @createTargetService(service, configOpts))
				.then (services) =>
					# If a named volume is defined in a service but NOT in the volumes of the compose file, we add it app-wide so that we can track it and purge it
					# !! DEPRECATED, WILL BE REMOVED IN NEXT MAJOR RELEASE !!
					for s in services
						serviceNamedVolumes = s.getNamedVolumes()
						for name in serviceNamedVolumes
							volumes[name] ?= @createTargetVolume(name, app.appId, { labels: {} })
					outApp = {
						appId: app.appId
						name: app.name
						commit: app.commit
						releaseId: app.releaseId
						services: services
						networks
						volumes
					}
					return outApp
		)

	setTarget: (apps, dependent , source, trx) ->
		setInTransaction = (filteredApps, trx) =>
			Promise.try =>
				appsArray = _.map filteredApps, (app, appId) ->
					appClone = _.clone(app)
					appClone.appId = checkInt(appId)
					appClone.source = source
					return appClone
				Promise.map(appsArray, @normaliseAppForDB)
				.tap (appsForDB) =>
					@targetStateWrapper.setTargetApps(appsForDB, trx)
				.then (appsForDB) ->
					trx('app').where({ source }).whereNotIn('appId',
						# Use apps here, rather than filteredApps, to
						# avoid removing a release from the database
						# without an application to replace it.
						# Currently this will only happen if the release
						# which would replace it fails a contract
						# validation check
						_.map(apps, (_, appId) -> checkInt(appId))
					).del()
			.then =>
				@proxyvisor.setTargetInTransaction(dependent, trx)

		# We look at the container contracts here, as if we
		# cannot run the release, we don't want it to be added
		# to the database, overwriting the current release. This
		# is because if we just reject the release, but leave it
		# in the db, if for any reason the current state stops
		# running, we won't restart it, leaving the device
		# useless - The exception to this rule is when the only
		# failing services are marked as optional, then we
		# filter those out and add the target state to the database
		contractViolators = {}
		Promise.resolve(validateTargetContracts(apps))
		.then (fulfilledContracts) =>
			filteredApps = _.cloneDeep(apps)
			_.each(
				fulfilledContracts,
				({ valid, unmetServices, fulfilledServices, unmetAndOptional }, appId) =>
					if not valid
						contractViolators[apps[appId].name] = unmetServices
						delete filteredApps[appId]
					else
						# valid is true, but we could still be missing
						# some optional containers, and need to filter
						# these out of the target state
						filteredApps[appId].services = _.pickBy filteredApps[appId].services, ({ serviceName }) ->
							fulfilledServices.includes(serviceName)
						if unmetAndOptional.length != 0
							@reportOptionalContainers(unmetAndOptional)
			)
			if trx?
				setInTransaction(filteredApps, trx)
			else
				@db.transaction(setInTransaction)
		.then =>
			@_targetVolatilePerImageId = {}
		.finally ->
			if not _.isEmpty(contractViolators)
				throw new ContractViolationError(contractViolators)

	setTargetVolatileForService: (imageId, target) =>
		@_targetVolatilePerImageId[imageId] ?= {}
		_.assign(@_targetVolatilePerImageId[imageId], target)

	clearTargetVolatileForServices: (imageIds) =>
		for imageId in imageIds
			@_targetVolatilePerImageId[imageId] = {}

	getTargetApps: =>
		Promise.map(@targetStateWrapper.getTargetApps(), @normaliseAndExtendAppFromDB)
		.map (app) =>
			if !_.isEmpty(app.services)
				app.services = _.map app.services, (service) =>
					if @_targetVolatilePerImageId[service.imageId]?
						_.merge(service, @_targetVolatilePerImageId[service.imageId])
					return service
			return app
		.then (apps) ->
			return _.keyBy(apps, 'appId')

	getDependentTargets: =>
		@proxyvisor.getTarget()

	bestDeltaSource: (image, available) ->
		if !image.dependent
			for availableImage in available
				if availableImage.serviceName == image.serviceName and availableImage.appId == image.appId
					return availableImage.name
		for availableImage in available
			if availableImage.appId == image.appId
				return availableImage.name
		return null

	# returns:
	# imagesToRemove: images that
	# - are not used in the current state, and
	# - are not going to be used in the target state, and
	# - are not needed for delta source / pull caching or would be used for a service with delete-then-download as strategy
	# imagesToSave: images that
	# - are locally available (i.e. an image with the same digest exists)
	# - are not saved to the DB with all their metadata (serviceId, serviceName, etc)
	_compareImages: (current, target, available, localMode) =>
		allImagesForTargetApp = (app) -> _.map(app.services, imageForService)
		allImagesForCurrentApp = (app) ->
			_.map app.services, (service) ->
				img = _.find(available, { dockerImageId: service.config.image, imageId: service.imageId }) ? _.find(available, { dockerImageId: service.config.image })
				return _.omit(img, [ 'dockerImageId', 'id' ])
		allImageDockerIdsForTargetApp = (app) ->
			_(app.services).map((svc) -> [ svc.imageName, svc.config.image ])
			.filter((img) -> img[1]?)
			.value()

		availableWithoutIds = _.map(available, (image) -> _.omit(image, [ 'dockerImageId', 'id' ]))
		currentImages = _.flatMap(current.local.apps, allImagesForCurrentApp)
		targetImages = _.flatMap(target.local.apps, allImagesForTargetApp)
		targetImageDockerIds = _.fromPairs(_.flatMap(target.local.apps, allImageDockerIdsForTargetApp))

		availableAndUnused = _.filter availableWithoutIds, (image) ->
			!_.some currentImages.concat(targetImages), (imageInUse) -> _.isEqual(image, imageInUse)

		imagesToDownload = _.filter targetImages, (targetImage) ->
			!_.some available, (availableImage) -> Images.isSameImage(availableImage, targetImage)

		# Images that are available but we don't have them in the DB with the exact metadata:
		imagesToSave = []
		if !localMode
			imagesToSave = _.filter targetImages, (targetImage) ->
				isActuallyAvailable = _.some(
					available, (availableImage) ->
						if Images.isSameImage(availableImage, targetImage)
							return true
						if availableImage.dockerImageId == targetImageDockerIds[targetImage.name]
							return true
						return false
				)
				isNotSaved = !_.some availableWithoutIds, (img) -> _.isEqual(img, targetImage)
				return isActuallyAvailable and isNotSaved

		deltaSources = _.map imagesToDownload, (image) =>
			return @bestDeltaSource(image, available)
		proxyvisorImages = @proxyvisor.imagesInUse(current, target)

		potentialDeleteThenDownload = _.filter current.local.apps.services, (svc) ->
			svc.config.labels['io.balena.update.strategy'] == 'delete-then-download' and svc.status == 'Stopped'

		imagesToRemove = _.filter availableAndUnused.concat(potentialDeleteThenDownload), (image) ->
			notUsedForDelta = !_.includes(deltaSources, image.name)
			notUsedByProxyvisor = !_.some proxyvisorImages, (proxyvisorImage) -> Images.isSameImage(image, { name: proxyvisorImage })
			return notUsedForDelta and notUsedByProxyvisor
		return { imagesToSave, imagesToRemove }

	_inferNextSteps: (cleanupNeeded, availableImages, downloading, supervisorNetworkReady, current, target, ignoreImages, { localMode, delta }, containerIds) =>
		volumePromises = []
		Promise.try =>
			if localMode
				ignoreImages = true
			currentByAppId = current.local.apps ? {}
			targetByAppId = target.local.apps ? {}

			# Given we need to detect when a device is moved
			# between applications, we do it this way. This code
			# is going to change to an application-manager +
			# application model, which means that we can just
			# detect when an application is no longer referenced
			# in the target state, and run the teardown that way.
			# Until then, this essentially does the same thing. We
			# check when every other part of the teardown for an
			# application has been complete, and then append the
			# volume removal steps.
			# We also don't want to remove cloud volumes when
			# switching to local mode
			# multi-app warning: this will break
			oldApps = null
			if !localMode
				currentAppIds = _.keys(current.local.apps).map((n) -> checkInt(n))
				targetAppIds = _.keys(target.local.apps).map((n) -> checkInt(n))
				appsForVolumeRemoval = _.difference(currentAppIds, targetAppIds)

			nextSteps = []
			if !supervisorNetworkReady
				# if the supervisor0 network isn't ready and there's any containers using it, we need
				# to kill them
				containersUsingSupervisorNetwork = false
				for appId in _.keys(currentByAppId)
					services = currentByAppId[appId].services
					for n of services
						if checkTruthy(services[n].config.labels['io.balena.features.supervisor-api'])
							containersUsingSupervisorNetwork = true
							if services[n].status != 'Stopping'
								nextSteps.push(serviceAction('kill', services[n].serviceId, services[n]))
							else
								nextSteps.push({ action: 'noop' })
				if !containersUsingSupervisorNetwork
					nextSteps.push({ action: 'ensureSupervisorNetwork' })
			else
				if !ignoreImages and _.isEmpty(downloading)
					if cleanupNeeded
						nextSteps.push({ action: 'cleanup' })
					{ imagesToRemove, imagesToSave } = @_compareImages(current, target, availableImages, localMode)
					for image in imagesToSave
						nextSteps.push({ action: 'saveImage', image })
					if _.isEmpty(imagesToSave)
						for image in imagesToRemove
							nextSteps.push({ action: 'removeImage', image })
				# If we have to remove any images, we do that before anything else
				if _.isEmpty(nextSteps)
					allAppIds = _.union(_.keys(currentByAppId), _.keys(targetByAppId))
					for appId in allAppIds
						nextSteps = nextSteps.concat(@_nextStepsForAppUpdate(currentByAppId[appId], targetByAppId[appId], localMode, containerIds[appId], availableImages, downloading))
						if _.includes(appsForVolumeRemoval, checkInt(appId))
							# We check if everything else has been done for
							# the old app to be removed. If it has, we then
							# remove all of the volumes
							if _.every(nextSteps, { action: 'noop' })
								volumePromises.push(@removeAllVolumesForApp(checkInt(appId)))
			newDownloads = _.filter(nextSteps, (s) -> s.action == 'fetch').length

			if !ignoreImages and delta and newDownloads > 0
				# Check that this is not the first pull for an
				# application, as we want to download all images then
				# Otherwise we want to limit the downloading of
				# deltas to constants.maxDeltaDownloads
				appImages = _.groupBy(availableImages, 'appId')
				downloadsToBlock = downloading.length + newDownloads - constants.maxDeltaDownloads

				nextSteps = _.filter nextSteps, (step, idx) ->
					if step.action == 'fetch' && downloadsToBlock > 0
						imagesForThisApp = appImages[step.image.appId]
						if !imagesForThisApp? or imagesForThisApp.length == 0
							# There isn't a valid image for the fetch
							# step, so we keep it
							return true
						else
							downloadsToBlock -= 1
							return false
					else
						return true

			if !ignoreImages and _.isEmpty(nextSteps) and !_.isEmpty(downloading)
				nextSteps.push({ action: 'noop' })
			return _.uniqWith(nextSteps, _.isEqual)
		.then (nextSteps) ->
			Promise.all(volumePromises).then (volSteps) ->
				nextSteps = nextSteps.concat(_.flatten(volSteps))
				return nextSteps


	stopAll: ({ force = false, skipLock = false } = {}) =>
		Promise.resolve(@services.getAll())
		.map (service) =>
			@_lockingIfNecessary service.appId, { force, skipLock }, =>
				@services.kill(service, { removeContainer: false, wait: true })
				.then =>
					delete @_containerStarted[service.containerId]

	_lockingIfNecessary: (appId, { force = false, skipLock = false } = {}, fn) =>
		if skipLock
			return Promise.try(fn)
		@config.get('lockOverride')
		.then (lockOverride) ->
			return lockOverride or force
		.then (force) ->
			updateLock.lock(appId, { force }, fn)

	executeStepAction: (step, { force = false, skipLock = false } = {}) =>
		if _.includes(@proxyvisor.validActions, step.action)
			return @proxyvisor.executeStepAction(step)
		if !_.includes(@validActions, step.action)
			return Promise.reject(new Error("Invalid action #{step.action}"))
		@actionExecutors[step.action](_.merge({}, step, { force, skipLock }))

	getExtraStateForComparison: (currentState, targetState) =>
		containerIdsByAppId = {}
		_(currentState.local.apps)
			.keys()
			.concat(_.keys(targetState.local.apps))
			.uniq()
			.each (id) =>
				intId = checkInt(id)
				containerIdsByAppId[intId] = @services.getContainerIdMap(intId)

		@config.get('localMode').then (localMode) =>
			Promise.props({
				cleanupNeeded: @images.isCleanupNeeded()
				availableImages: @images.getAvailable(localMode)
				downloading: @images.getDownloadingImageIds()
				supervisorNetworkReady: @networks.supervisorNetworkReady()
				delta: @config.get('delta')
				containerIds: Promise.props(containerIdsByAppId)
				localMode
			})

	getRequiredSteps: (currentState, targetState, extraState, ignoreImages = false) =>
		{ cleanupNeeded, availableImages, downloading, supervisorNetworkReady, delta, localMode, containerIds } = extraState
		conf = { delta, localMode }
		if conf.localMode
			cleanupNeeded = false

		@_inferNextSteps(cleanupNeeded, availableImages, downloading, supervisorNetworkReady, currentState, targetState, ignoreImages, conf, containerIds)
		.then (nextSteps) =>
			if ignoreImages and _.some(nextSteps, action: 'fetch')
				throw new Error('Cannot fetch images while executing an API action')
			@proxyvisor.getRequiredSteps(availableImages, downloading, currentState, targetState, nextSteps)
			.then (proxyvisorSteps) ->
				return nextSteps.concat(proxyvisorSteps)

	serviceNameFromId: (serviceId) =>
		@getTargetApps().then (apps) ->
			# Multi-app warning!
			# We assume here that there will only be a single
			# application
			for appId, app of apps
				return _.find app.services, (svc) ->
					svc.serviceId == serviceId
		.get('serviceName')

	removeAllVolumesForApp: (appId) =>
		@volumes.getAllByAppId(appId).then (volumes) ->
			return volumes.map((v) -> { action: 'removeVolume', current: v })

	localModeSwitchCompletion: => @localModeManager.switchCompletion()

	reportOptionalContainers: (serviceNames) =>
		# Print logs to the console and dashboard, letting the
		# user know that we're not going to run certain services
		# because of their contract
		message = "Not running containers because of contract violations: #{serviceNames.join('. ')}"
		log.info(message)
		@logger.logSystemMessage(message, {}, 'optionalContainerViolation', true)

