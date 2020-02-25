import * as _ from 'lodash';

import ApplicationManager from './application-manager';
import Config from './config';
import Database, { Transaction } from './db';
import * as globalEventBus from './event-bus';

// Once we have correct types for both applications and the
// incoming target state this should be changed
export type DatabaseApp = Dictionary<any>;
export type DatabaseApps = DatabaseApp[];

/*
 * This class is a wrapper around the database setting and
 * receiving of target state. Because the target state can
 * only be set from a single place, but several workflows
 * rely on getting the target state at one point or another,
 * we cache the values using this class. Accessing the
 * database is inherently expensive, and for example the
 * local log backend accesses the target state for every log
 * line. This can very quickly cause serious memory problems
 * and database connection timeouts.
 */
export class TargetStateAccessor {
	private targetState?: DatabaseApps;

	public constructor(
		protected applications: ApplicationManager,
		protected config: Config,
		protected db: Database,
	) {
		// If we switch backend, the target state also needs to
		// be invalidated (this includes switching to and from
		// local mode)
		globalEventBus.getInstance().on('configChanged', conf => {
			if (conf.apiEndpoint != null || conf.localMode != null) {
				this.targetState = undefined;
			}
		});
	}

	public async getTargetApp(appId: number): Promise<DatabaseApp | undefined> {
		if (this.targetState == null) {
			// TODO: Perhaps only fetch a single application from
			// the DB, at the expense of repeating code
			await this.getTargetApps();
		}

		return _.find(this.targetState, app => app.appId === appId);
	}

	public async getTargetApps(): Promise<DatabaseApp> {
		if (this.targetState == null) {
			const { apiEndpoint, localMode } = await this.config.getMany([
				'apiEndpoint',
				'localMode',
			]);

			const source = localMode ? 'local' : apiEndpoint;
			this.targetState = await this.db.models('app').where({ source });
		}
		return this.targetState!;
	}

	public async setTargetApps(
		apps: DatabaseApps,
		trx: Transaction,
	): Promise<void> {
		// We can't cache the value here, as it could be for a
		// different source
		this.targetState = undefined;

		await Promise.all(
			apps.map(app =>
				this.db.upsertModel('app', app, { appId: app.appId }, trx),
			),
		);
	}
}

export default TargetStateAccessor;
