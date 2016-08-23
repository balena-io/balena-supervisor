Promise = require 'bluebird'
{ docker } = require './docker-utils'
express = require 'express'
fs = Promise.promisifyAll require 'fs'
tar = require 'tar-fs'
{ resinApi } = require './request'
knex = require './db'
_ = require 'lodash'
deviceRegister = require 'resin-register-device'
randomHexString = require './lib/random-hex-string'
utils = require './utils'
device = require './device'
bodyParser = require 'body-parser'
request = Promise.promisifyAll require 'request'
config = require './config'

getAssetsPath = (image) ->
	docker.imageRootDir(image)
	.then (rootDir) ->
		return rootDir + '/assets'

exports.router = router = express.Router()
router.use(bodyParser())

router.get '/v1/devices', (req, res) ->
# get from api or local db?

router.post '/v1/devices', (req, res) ->
	Promise.join(
		utils.getConfig('apiKey')
		utils.getConfig('userId')
		device.getID()
		deviceRegister.generateUUID()
		randomHexString.generate()
		(apiKey, userId, deviceId, uuid, logsChannel) ->
			device =
				user: userId
				application: req.body.applicationId
				uuid: uuid
				device_type: req.body.deviceType or 'edge'
				device: deviceId
				registered_at: Math.floor(Date.now() / 1000)
				logs_channel: logsChannel
				status: 'Provisioned'
			resinApi.post
				resource: 'device'
				body: device
				customOptions:
					apikey: apiKey
			.then (dev) ->
				deviceForDB = {
					uuid
					appId: device.application
					device_type: device.device_type
					deviceId: dev.id
					name: dev.name
					status: device.status
				}
				knex('dependentDevice').insert(deviceForDB)
				.then ->
					res.status(202).send(dev)
	)
	.catch (err) ->
		res.status(503).send(err?.message or err or 'Unknown error')

router.get '/v1/devices/:uuid', (req, res) ->

#TODO later
router.put '/v1/devices/:uuid/logs', (req, res) ->

router.put '/v1/devices/:uuid/state', (req, res) ->

tarPath = (app) ->
	return '/tmp/' + app.commit + '.tar'

router.get '/v1/assets/:commit', (req, res) ->
	knex('dependentApp').select().where({ commit: req.params.commit })
	.then ([ app ]) ->
		return res.status(404).send('Not found') if !app
		dest = tarPath(app)
		getAssetsPath(app.imageId)
		.then (path) ->
			getTarArchive(path, dest)
		.then (archive) ->
			new Promise (resolve, reject) ->
				archive.on 'finish', ->
					res.sendFile(dest)
					resolve()
				archive.on 'error', (err) ->
					reject(err)
	.catch (err) ->
		console.error(err)
		res.status(503).send(err?.message or err or 'Unknown error')

getTarArchive = (path, destination) ->
	fs.lstatAsync(path)
	.then ->
		tarArchive = fs.createWriteStream(destination)
		tar.pack(path).pipe tarArchive
		return tarArchive

# TODO: deduplicate code from compareForUpdate in application.coffee
exports.fetchAndSetTargetsForDependentApps = (state, fetchFn) ->
	knex('dependentApp').select()
	.then (localDependentApps) ->
		# Compare to see which to fetch, and which to delete
		remoteApps = _.mapValues state.apps, (app, appId) ->
			return {
				appId: appId
				imageId: app.image
				commit: app.commit
				env: JSON.stringify(app.environment)
			}
		localApps = _.indexBy(localDependentApps, 'appId')

		toBeDownloaded = _.filter remoteApps, (app, appId) ->
			return !_.any localApps, (localApp) ->
				localApp.imageId == app.imageId
		toBeRemoved = _.filter localApps, (app, appId) ->
			return !_.any remoteApps, (remoteApp) ->
				remoteApp.imageId == app.imageId
		Promise.map toBeDownloaded, (app, appId) ->
			fetchFn(app, false)
		.then ->
			Promise.map toBeRemoved, (app) ->
				fs.unlinkAsync(tarPath(app))
				.then ->
					docker.getImage(app.imageId).removeAsync()
				.catch (err) ->
					console.error('Could not remove image/artifacts for dependent app', err, err.stack)
		.then ->
			Promise.map remoteApps, (app, appId) ->
				knex('dependentApp').update(app).where({ appId })
				.then (n) ->
					knex('dependentApp').insert(app) if n == 0
		.then ->
			devices = _.map state.devices, (device, uuid) ->
				device.uuid = uuid
				return device
			Promise.map devices, (device) ->
				# Only consider one app per dependent device for now
				appId = _.keys(device.apps)[0]
				knex('dependentDevice').update({ targetEnv: JSON.stringify(device.environment), targetCommit: state.apps[appId].commit }).where({ uuid: device.uuid })
	.catch (err) ->
		console.error('Error fetching dependent apps', err, err.stack)

sendUpdate = (device) ->
	request.putAsync("#{config.proxyvisorHookReceiver}/v1/devices/#{device.uuid}", { json: true, body: { commit: device.targetCommit, environment: JSON.parse(device.targetEnv) } })
	.spread (response, body) ->
		if response.statusCode != 200
			return console.log("Error updating device #{device.uuid}: #{response.statusCode} #{body}")
		knex('dependentDevice').update({ env: device.targetEnv, commit: device.targetCommit }).where({ uuid: device.uuid })

exports.sendUpdates = ->
	# Go through knex('dependentDevice') and sendUpdate if targetImage or targetEnv differ from the current ones.
	knex('dependentDevice').select()
	.then (devices) ->
		Promise.map devices, (device) ->
			sendUpdate(device) if device.targetEnv != device.env or device.targetCommit != device.commit
