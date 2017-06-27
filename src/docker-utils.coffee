Docker = require 'docker-toolbelt'
{ DockerProgress } = require 'docker-progress'
Promise = require 'bluebird'
progress = require 'request-progress'
dockerDelta = require 'docker-delta'
constants = require './constants'
_ = require 'lodash'
knex = require './db'
{ request } = require './request'
Lock = require 'rwlock'
utils = require './utils'
rimraf = Promise.promisify(require('rimraf'))

docker = new Docker(socketPath: constants.dockerSocket)

exports.docker = docker
dockerProgress = new DockerProgress(socketPath: constants.dockerSocket)

# Create an array of (repoTag, image_id, created) tuples like the output of `docker images`
listRepoTagsAsync = ->
	docker.listImagesAsync()
	.then (images) ->
		images = _.orderBy(images, 'Created', [ false ])
		ret = []
		for image in images
			for repoTag in image.RepoTags
				ret.push [ repoTag, image.Id, image.Created ]
		return ret

# Find either the most recent image of the same app or the image of the supervisor.
# Returns an image Id or Tag (depending on whatever's available)
findSimilarImage = (repoTag) ->
	application = repoTag.split('/')[1]

	listRepoTagsAsync()
	.then (repoTags) ->
		# Find the most recent image of the same application
		for repoTag in repoTags
			otherApplication = repoTag[0].split('/')[1]
			if otherApplication is application
				return repoTag[0]

		# Otherwise we start from scratch
		return 'resin/scratch'

getRepoAndTag = (image) ->
	docker.getRegistryAndName(image)
	.then ({ registry, imageName, tagName }) ->
		registry = registry.toString().replace(':443', '')
		return { repo: "#{registry}/#{imageName}", tag: tagName }

do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	_readLock = Promise.promisify(_lock.async.readLock)
	writeLockImages = ->
		_writeLock('images')
		.disposer (release) ->
			release()
	readLockImages = ->
		_readLock('images')
		.disposer (release) ->
			release()

	exports.rsyncImageWithProgress = (imgDest, { requestTimeout, totalTimeout, uuid, apiKey, startFromEmpty = false, deltaEndpoint, apiEndpoint }, onProgress) ->
		Promise.using readLockImages(), ->
			Promise.try ->
				if startFromEmpty
					return 'resin/scratch'
				findSimilarImage(imgDest)
			.then (imgSrc) ->
				Promise.join docker.getRegistryAndName(imgDest), docker.getRegistryAndName(imgSrc), (dstInfo, srcInfo) ->
					tokenEndpoint = "#{apiEndpoint}/auth/v1/token"
					opts =
						auth:
							user: 'd_' + uuid
							pass: apiKey
							sendImmediately: true
						json: true
						timeout: requestTimeout
					url = "#{tokenEndpoint}?service=#{dstInfo.registry}&scope=repository:#{dstInfo.imageName}:pull&scope=repository:#{srcInfo.imageName}:pull"
					request.getAsync(url, opts)
					.get(1)
					.then (b) ->
						opts =
							timeout: requestTimeout

						if b?.token?
							deltaAuthOpts =
								auth:
									bearer: b?.token
									sendImmediately: true
							opts = _.merge(opts, deltaAuthOpts)
						new Promise (resolve, reject) ->
							progress request.get("#{deltaEndpoint}/api/v2/delta?src=#{imgSrc}&dest=#{imgDest}", opts)
							.on 'progress', (progress) ->
								# In request-progress ^2.0.1, "percentage" is a ratio from 0 to 1
								onProgress(percentage: progress.percentage * 100)
							.on 'end', ->
								onProgress(percentage: 100)
							.on 'response', (res) ->
								if res.statusCode is 504
									reject(new Error('Delta server is still processing the delta, will retry'))
								else if res.statusCode isnt 200
									reject(new Error("Got #{res.statusCode} when requesting image from delta server."))
								else
									if imgSrc is 'resin/scratch'
										deltaSrc = null
									else
										deltaSrc = imgSrc
									res.pipe(dockerDelta.applyDelta(deltaSrc, imgDest))
									.on('id', resolve)
									.on('error', reject)
							.on 'error', reject
				.timeout(totalTimeout)
			.then (id) ->
				getRepoAndTag(imgDest)
				.then ({ repo, tag }) ->
					docker.getImage(id).tagAsync({ repo, tag, force: true })
			.catch dockerDelta.OutOfSyncError, (err) ->
				console.log('Falling back to delta-from-empty')
				exports.rsyncImageWithProgress(imgDest, { requestTimeout, totalTimeout, uuid, apiKey, startFromEmpty: true }, onProgress)

	exports.fetchImageWithProgress = (image, onProgress, { uuid, apiKey }) ->
		Promise.using readLockImages(), ->
			docker.getRegistryAndName(image)
			.then ({ registry, imageName, tagName }) ->
				dockerOptions =
					authconfig:
						username: 'd_' + uuid,
						password: apiKey,
						serveraddress: registry
				dockerProgress.pull(image, onProgress, dockerOptions)

	normalizeRepoTag = (image) ->
		getRepoAndTag(image)
		.then ({ repo, tag }) ->
			buildRepoTag(repo, tag)

	supervisorTagPromise = normalizeRepoTag(constants.supervisorImage)

	exports.cleanupContainersAndImages = (extraImagesToIgnore = []) ->
		Promise.using writeLockImages(), ->
			Promise.join(
				knex('app').select()
				.map ({ imageId }) ->
					normalizeRepoTag(imageId)
				knex('dependentApp').select().whereNotNull('imageId')
				.map ({ imageId }) ->
					normalizeRepoTag(imageId)
				supervisorTagPromise
				docker.listImagesAsync()
				.map (image) ->
					image.NormalizedRepoTags = Promise.map(image.RepoTags, normalizeRepoTag)
					Promise.props(image)
				Promise.map(extraImagesToIgnore, normalizeRepoTag)
				(apps, dependentApps, supervisorTag, images, normalizedExtraImages) ->
					imageTags = _.map(images, 'NormalizedRepoTags')
					supervisorTags = _.filter imageTags, (tags) ->
						_.includes(tags, supervisorTag)
					appTags = _.filter imageTags, (tags) ->
						_.some tags, (tag) ->
							_.includes(apps, tag) or _.includes(dependentApps, tag)
					extraTags = _.filter imageTags, (tags) ->
						_.some tags, (tag) ->
							_.includes(normalizedExtraImages, tag)
					supervisorTags = _.flatten(supervisorTags)
					appTags = _.flatten(appTags)
					extraTags = _.flatten(extraTags)

					return { images, supervisorTags, appTags, extraTags }
			)
			.then ({ images, supervisorTags, appTags, extraTags }) ->
				# Cleanup containers first, so that they don't block image removal.
				docker.listContainersAsync(all: true)
				.filter (containerInfo) ->
					# Do not remove user apps.
					normalizeRepoTag(containerInfo.Image)
					.then (repoTag) ->
						if _.includes(appTags, repoTag)
							return false
						if _.includes(extraTags, repoTag)
							return false
						if !_.includes(supervisorTags, repoTag)
							return true
						return containerHasExited(containerInfo.Id)
				.map (containerInfo) ->
					docker.getContainer(containerInfo.Id).removeAsync(v: true, force: true)
					.then ->
						console.log('Deleted container:', containerInfo.Id, containerInfo.Image)
					.catch(_.noop)
				.then ->
					imagesToClean = _.reject images, (image) ->
						_.some image.NormalizedRepoTags, (tag) ->
							return _.includes(appTags, tag) or _.includes(supervisorTags, tag) or _.includes(extraTags, tag)
					Promise.map imagesToClean, (image) ->
						Promise.map image.RepoTags.concat(image.Id), (tag) ->
							docker.getImage(tag).removeAsync(force: true)
							.then ->
								console.log('Deleted image:', tag, image.Id, image.RepoTags)
							.catch(_.noop)

	containerHasExited = (id) ->
		docker.getContainer(id).inspectAsync()
		.then (data) ->
			return not data.State.Running

	buildRepoTag = (repo, tag, registry) ->
		repoTag = ''
		if registry?
			repoTag += registry + '/'
		repoTag += repo
		if tag?
			repoTag += ':' + tag
		else
			repoTag += ':latest'
		return repoTag

	exports.getImageEnv = (id) ->
		docker.getImage(id).inspectAsync()
		.get('Config').get('Env')
		.then (env) ->
			# env is an array of strings that say 'key=value'
			_(env)
			.invokeMap('split', '=')
			.fromPairs()
			.value()
		.catch (err) ->
			console.log('Error getting env from image', err, err.stack)
			return {}
