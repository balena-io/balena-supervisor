import { NextFunction, Request, Response } from 'express';
import * as express from 'express';
import { Server } from 'http';
import * as _ from 'lodash';
import * as morgan from 'morgan';

import Config from './config';
import * as globalEventBus from './event-bus';
import { EventTracker } from './event-tracker';
import blink = require('./lib/blink');
import * as iptables from './lib/iptables';
import { checkTruthy } from './lib/validation';

import log from './lib/supervisor-console';

function getKeyFromReq(req: express.Request): string | null {
	const queryKey = req.query.apikey;
	if (queryKey != null) {
		return queryKey;
	}
	const maybeHeaderKey = req.get('Authorization');
	if (!maybeHeaderKey) {
		return null;
	}

	const match = maybeHeaderKey.match(/^ApiKey (\w+)$/);
	return match != null ? match[1] : null;
}

function authenticate(config: Config): express.RequestHandler {
	return async (req, res, next) => {
		try {
			const conf = await config.getMany([
				'apiSecret',
				'localMode',
				'unmanaged',
				'osVariant',
			]);

			const needsAuth = conf.unmanaged
				? conf.osVariant === 'prod'
				: !conf.localMode;

			if (needsAuth) {
				// Only get the key if we need it
				const key = getKeyFromReq(req);
				if (key && conf.apiSecret && key === conf.apiSecret) {
					return next();
				} else {
					return res.sendStatus(401);
				}
			} else {
				return next();
			}
		} catch (err) {
			res.status(503).send(`Unexpected error: ${err}`);
		}
	};
}

const expressLogger = morgan(
	(tokens, req, res) =>
		[
			tokens.method(req, res),
			req.path,
			tokens.status(req, res),
			'-',
			tokens['response-time'](req, res),
			'ms',
		].join(' '),
	{
		stream: { write: d => log.api(d.toString().trimRight()) },
	},
);

interface SupervisorAPIConstructOpts {
	config: Config;
	eventTracker: EventTracker;
	routers: express.Router[];
	healthchecks: Array<() => Promise<boolean>>;
}

export class SupervisorAPI {
	private config: Config;
	private eventTracker: EventTracker;
	private routers: express.Router[];
	private healthchecks: Array<() => Promise<boolean>>;

	private api = express();
	private server: Server | null = null;

	public constructor({
		config,
		eventTracker,
		routers,
		healthchecks,
	}: SupervisorAPIConstructOpts) {
		this.config = config;
		this.eventTracker = eventTracker;
		this.routers = routers;
		this.healthchecks = healthchecks;

		this.api.disable('x-powered-by');
		this.api.use(expressLogger);

		this.api.get('/v1/healthy', async (_req, res) => {
			const healths = await Promise.all(this.healthchecks.map(fn => fn()));
			if (!_.every(healths)) {
				throw new Error('Unhealthy');
			}
			return res.sendStatus(200);
		});

		this.api.get('/ping', (_req, res) => res.send('OK'));

		this.api.use(authenticate(this.config));

		this.api.post('/v1/blink', (_req, res) => {
			this.eventTracker.track('Device blink');
			blink.pattern.start();
			setTimeout(blink.pattern.stop, 15000);
			return res.sendStatus(200);
		});

		// Expires the supervisor's API key and generates a new one.
		// It also communicates the new key to the balena API.
		this.api.post('/v1/regenerate-api-key', async (_req, res) => {
			const secret = await this.config.newUniqueKey();
			await this.config.set({ apiSecret: secret });
			res.status(200).send(secret);
		});

		// And assign all external routers
		for (const router of this.routers) {
			this.api.use(router);
		}

		// Error handling.

		const messageFromError = (err?: Error | string | null): string => {
			let message = 'Unknown error';
			if (err != null) {
				if (_.isError(err) && err.message != null) {
					message = err.message;
				} else {
					message = err as string;
				}
			}
			return message;
		};

		this.api.use(
			(err: Error, req: Request, res: Response, next: NextFunction) => {
				if (res.headersSent) {
					// Error happens while we are writing the response - default handler closes the connection.
					next(err);
					return;
				}
				log.error(`Error on ${req.method} ${req.path}: `, err);
				res.status(503).send({
					status: 'failed',
					message: messageFromError(err),
				});
			},
		);
	}

	public async listen(
		allowedInterfaces: string[],
		port: number,
		apiTimeout: number,
	): Promise<void> {
		const localMode = await this.config.get('localMode');
		await this.applyListeningRules(localMode || false, port, allowedInterfaces);

		// Monitor the switching of local mode, and change which interfaces will
		// be listened to based on that
		globalEventBus.getInstance().on('configChanged', changedConfig => {
			if (changedConfig.localMode != null) {
				this.applyListeningRules(
					changedConfig.localMode || false,
					port,
					allowedInterfaces,
				);
			}
		});

		this.server = this.api.listen(port);
		this.server.timeout = apiTimeout;
	}

	private async applyListeningRules(
		allInterfaces: boolean,
		port: number,
		allowedInterfaces: string[],
	): Promise<void> {
		try {
			if (checkTruthy(allInterfaces)) {
				await iptables.removeRejections(port);
				log.debug('Supervisor API listening on all interfaces');
			} else {
				await iptables.rejectOnAllInterfacesExcept(allowedInterfaces, port);
				log.debug('Supervisor API listening on allowed interfaces only');
			}
		} catch (err) {
			log.error(
				'Error on switching supervisor API listening rules - stopping API.\n',
				err,
			);
			this.stop();
		}
	}

	public stop() {
		if (this.server != null) {
			this.server.close();
		}
	}
}

export default SupervisorAPI;
