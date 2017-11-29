Promise = require 'bluebird'
_ = require 'lodash'
TypedError = require 'typed-error'
lockFile = Promise.promisifyAll(require('lockfile'))
Lock = require 'rwlock'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'

constants = require './constants'

ENOENT = (err) -> err.code is 'ENOENT'

baseLockPath = (appId) ->
	return path.join('/tmp/resin-supervisor/services', appId.toString())

exports.lockPath = (appId, serviceName) ->
	return path.join(baseLockPath(appId), serviceName)

lockFileOnHost = (appId, serviceName) ->
	return path.join(constants.rootMountPoint, exports.lockPath(appId, serviceName), 'resin-updates.lock')

exports.UpdatesLockedError = class UpdatesLockedError extends TypedError

exports.lock = do ->
	_lock = new Lock()
	_writeLock = Promise.promisify(_lock.async.writeLock)
	return (appId, { force = false } = {}, fn) ->
		takeTheLock = ->
			Promise.try ->
				return if !appId?
				locksTaken = []
				dispose = (release) ->
					Promise.map locksTaken, (lockName) ->
						lockFile.unlockAsync(lockName)
					.finally ->
						release()
				_writeLock(appId)
				.tap (release) ->
					theLockDir = path.join(constants.rootMountPoint, baseLockPath(appId))
					fs.readdirAsync(theLockDir)
					.catch ENOENT, -> []
					.mapSeries (serviceName) ->
						tmpLockName = lockFileOnHost(appId, serviceName)
						Promise.try ->
							lockFile.unlockAsync(tmpLockName) if force == true
						.then ->
							lockFile.lockAsync(tmpLockName)
							.then ->
								locksTaken.push(tmpLockName)
						.catch ENOENT, _.noop
						.catch (err) ->
							dispose(release)
							.finally ->
								throw new exports.UpdatesLockedError("Updates are locked: #{err.message}")
				.disposer(dispose)
		Promise.using takeTheLock(), -> fn()
