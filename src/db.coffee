Promise = require 'bluebird'
Knex = require 'knex'

constants = require './lib/constants'

module.exports = class DB
	constructor: ({ databasePath } = {}) ->
		@knex = Knex(
			client: 'sqlite3'
			connection:
				filename: databasePath ? constants.databasePath
			useNullAsDefault: true
		)

	addColumn: (table, column, type) =>
		@knex.schema.hasColumn(table, column)
		.then (exists) =>
			if not exists
				@knex.schema.table table, (t) ->
					t[type](column)

	dropColumn: (table, column) =>
		@knex.schema.hasColumn(table, column)
		.then (exists) =>
			if exists
				@knex.schema.table table, (t) ->
					t.dropColumn(column)

	init: =>
		Promise.all([
			@knex.schema.hasTable('config')
			.then (exists) =>
				if not exists
					@knex.schema.createTable 'config', (t) ->
						t.string('key').primary()
						t.string('value')

			@knex.schema.hasTable('deviceConfig')
			.then (exists) =>
				if not exists
					@knex.schema.createTable 'deviceConfig', (t) ->
						t.json('values')
						t.json('targetValues')
			.then =>
				@knex('deviceConfig').select()
				.then (deviceConfigs) =>
					@knex('deviceConfig').insert({ values: '{}', targetValues: '{}' }) if deviceConfigs.length == 0

			@knex.schema.hasTable('app')
			.then (exists) =>
				if not exists
					@knex.schema.createTable 'app', (t) ->
						t.increments('id').primary()
						t.string('name')
						t.string('commit')
						t.string('imageId')
						t.string('appId')
						t.json('env')
						t.json('config')
				else
					Promise.all [
						@dropColumn('app', 'privileged')
						@dropColumn('app', 'containerId')
						@addColumn('app', 'commit', 'string')
						@addColumn('app', 'appId', 'string')
						@addColumn('app', 'config', 'json')
					]
					.then =>
						# When updating from older supervisors, config can be null
						@knex('app').update({ config: '{}' }).whereNull('config')

			@knex.schema.hasTable('dependentApp')
			.then (exists) =>
				if not exists
					@knex.schema.createTable 'dependentApp', (t) ->
						t.increments('id').primary()
						t.string('appId')
						t.string('parentAppId')
						t.string('name')
						t.string('commit')
						t.string('imageId')
						t.json('config')
						t.json('environment')
				else
					@addColumn('dependentApp', 'environment', 'json')

			@knex.schema.hasTable('dependentDevice')
			.then (exists) =>
				if not exists
					@knex.schema.createTable 'dependentDevice', (t) ->
						t.increments('id').primary()
						t.string('uuid')
						t.string('appId')
						t.string('localId')
						t.string('device_type')
						t.string('logs_channel')
						t.string('deviceId')
						t.boolean('is_online')
						t.string('name')
						t.string('status')
						t.string('download_progress')
						t.string('is_managed_by')
						t.dateTime('lock_expiry_date')
						t.string('commit')
						t.string('targetCommit')
						t.json('environment')
						t.json('targetEnvironment')
						t.json('config')
						t.json('targetConfig')
						t.boolean('markedForDeletion')
				else
					Promise.all [
						@addColumn('dependentDevice', 'markedForDeletion', 'boolean')
						@addColumn('dependentDevice', 'localId', 'string')
						@addColumn('dependentDevice', 'is_managed_by', 'string')
						@addColumn('dependentDevice', 'lock_expiry_date', 'dateTime')
				]

			# Dropping these tables if they exist from older supervisors.
			# This will also help us avoid problems
			# in case we ever want to reuse them
			@knex.schema.dropTableIfExists('image')
			@knex.schema.dropTableIfExists('container')
		])

	# Returns a knex object for one of the models (tables)
	models: (modelName) ->
		@knex(modelName)

	upsertModel: (modelName, obj, id) ->
		@knex(modelName).update(obj).where(id)
		.then (n) =>
			@knex(modelName).insert(obj) if n == 0

	transaction: (cb) ->
		@knex.transaction(cb)
