
exports.singleToMulticontainerApp = (app, appId) ->
	newApp = {
		appId
		commit: app.commit
		name: app.name
		buildId: '1'
		networks: {}
		volumes: { "resin-data-#{appId}": {} }
		config: app.config ? {}
	}
	newApp.services = [
		{
			serviceId: '1'
			serviceName: 'main'
			containerId: '1'
			commit: app.commit
			buildId: app.buildId ? '1'
			image: app.image
			privileged: true
			network_mode: 'host'
			volumes: [
				"resin-data-#{appId}:/data"
			]
			labels: {
				'io.resin.features.kernel_modules': '1'
				'io.resin.features.firmware': '1'
				'io.resin.features.dbus': '1'
				'io.resin.features.supervisor_api': '1'
				'io.resin.features.resin_api': '1'
				'io.resin.update.strategy': newApp.config['RESIN_SUPERVISOR_UPDATE_STRATEGY'] ? 'download-then-kill'
				'io.resin.update.handover_timeout': newApp.config['RESIN_SUPERVISOR_HANDOVER_TIMEOUT'] ? ''
			}
			environment: app.environment ? {}
			restart: 'unless-stopped'
			running: true
		}
	]
	return newApp