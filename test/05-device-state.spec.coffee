Promise = require 'bluebird'
m = require 'mochainon'

{ stub } = m.sinon
m.chai.use(require('chai-events'))
{ expect } = m.chai

prepare = require './lib/prepare'
DeviceState = require '../src/device-state'
Knex = require('../src/db')
Config = require('../src/config')

containerConfig = require '../src/lib/container-config'
mixpanel = require '../src/mixpanel'

describe 'deviceState', ->
	before ->
		prepare()
		@db = new Knex()
		@config = new Config({ @db })
		@deviceState = new DeviceState({ @db, @config })
		stub(containerConfig, 'extendEnvVars').callsFake (env) ->
			env['ADDITIONAL_ENV_VAR'] = 'its value'
			Promise.resolve(env)
		stub(mixpanel, 'track').callsFake(console.log)
		@db.init()
		.then =>
			@config.init()

	after ->
		containerConfig.extendEnvVars.restore()
		mixpanel.track.restore()

	it 'loads a target state from an apps.json file and saves it as target state, then returns it', ->
		@config.set({ name: '' })
		.then =>
			@deviceState.loadTargetFromFile(process.env.ROOT_MOUNTPOINT + '/apps.json')
		.then =>
			@deviceState.getTarget()
		.then (targetState) ->
			expect(targetState).to.deep.equal({
				local: {
					name: ''
					config: {
						'RESIN_HOST_CONFIG_gpu_mem': '256'
						'RESIN_HOST_LOG_TO_DISPLAY': '0'
					}
					apps:{
						'1234': {
							name: 'superapp'
							image: 'registry2.resin.io/superapp/abcdef'
							commit: 'abcdef'
							environment: {
								'FOO': 'bar'
								'ADDITIONAL_ENV_VAR': 'its value'
							}
							config: {
								'RESIN_HOST_CONFIG_gpu_mem': '256'
								'RESIN_HOST_LOG_TO_DISPLAY': '0'
							}
						}
					}
				}
				dependent: { apps: {}, devices: {}}
			})

	it 'emits a change event when a new state is reported', ->
		@deviceState.reportCurrent({ someStateDiff: 'someValue' })
		expect(@deviceState).to.emit('current-state-change')

	it 'returns the current state'

	it 'writes the target state to te db'

	it 'applies the target state for device config'

	it 'applies the target state for applications'

	it 'calls the proxyvisor to apply dependent device target states'
