import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import * as _ from 'lodash';

import Config from './config';
import Database from './db';
import * as globalEventBus from './event-bus';
import * as constants from './lib/constants';
import { SupervisorContainerNotFoundError } from './lib/errors';
import log from './lib/supervisor-console';
import { Logger } from './logger';
// EngineSnapshot represents a list of containers, images, volumens, and networks present on the engine.
// A snapshot is taken before entering local mode in order to perform cleanup when we exit local mode.
export class EngineSnapshot {
	constructor(
		public readonly containers: string[],
		public readonly images: string[],
		public readonly volumes: string[],
		public readonly networks: string[],
	) {}

	public static fromJSON(json: string): EngineSnapshot {
		const obj = JSON.parse(json);
		return new EngineSnapshot(
			obj.containers,
			obj.images,
			obj.volumes,
			obj.networks,
		);
	}

	// Builds a new snapshot object that contains entities present in another snapshot,
	// but not present in this one.
	public diff(another: EngineSnapshot): EngineSnapshot {
		return new EngineSnapshot(
			_.difference(this.containers, another.containers),
			_.difference(this.images, another.images),
			_.difference(this.volumes, another.volumes),
			_.difference(this.networks, another.networks),
		);
	}

	public toString(): string {
		return (
			`${this.containers.length} containers, ` +
			`${this.images.length} images, ` +
			`${this.volumes.length} volumes, ` +
			`${this.networks.length} networks`
		);
	}
}

// Record in a database that stores EngineSnapshot.
export class EngineSnapshotRecord {
	constructor(
		public readonly snapshot: EngineSnapshot,
		public readonly timestamp: Date,
	) {}
}

/** Container name used to inspect own resources when container ID cannot be resolved. */
const SUPERVISOR_CONTAINER_NAME_FALLBACK = 'resin_supervisor';

/**
 * This class handles any special cases necessary for switching
 * modes in localMode.
 *
 * Currently this is needed because of inconsistencies in the way
 * that the state machine handles local mode and normal operation.
 * We should aim to remove these inconsistencies in the future.
 */
export class LocalModeManager {
	public constructor(
		public config: Config,
		public docker: Docker,
		public logger: Logger,
		public db: Database,
		private containerId: string | undefined = constants.containerId,
	) {}

	// Indicates that switch from or to the local mode is not complete.
	private switchInProgress: Bluebird<void> | null = null;

	public async init() {
		// Setup a listener to catch state changes relating to local mode
		globalEventBus.getInstance().on('configChanged', changed => {
			if (changed.localMode != null) {
				const local = changed.localMode || false;

				// First switch the logger to it's correct state
				this.logger.switchBackend(local);

				this.startLocalModeChangeHandling(local);
			}
		});

		// On startup, check if we're in unmanaged mode,
		// as local mode needs to be set
		let unmanagedLocalMode = false;
		if (await this.config.get('unmanaged')) {
			log.info('Starting up in unmanaged mode, activating local mode');
			await this.config.set({ localMode: true });
			unmanagedLocalMode = true;
		}

		const localMode =
			// short circuit the next get if we know we're in local mode
			unmanagedLocalMode || (await this.config.get('localMode'));

		if (!localMode) {
			// Remove any leftovers if necessary
			await this.handleLocalModeStateChange(false);
		}
	}

	public startLocalModeChangeHandling(local: boolean) {
		this.switchInProgress = Bluebird.resolve(
			this.handleLocalModeStateChange(local),
		).finally(() => {
			this.switchInProgress = null;
		});
	}

	// Query the engine to get currently running containers and installed images.
	public async collectEngineSnapshot(): Promise<EngineSnapshotRecord> {
		const containersPromise = this.docker
			.listContainers()
			.then(resp => _.map(resp, 'Id'));
		const imagesPromise = this.docker
			.listImages()
			.then(resp => _.map(resp, 'Id'));
		const volumesPromise = this.docker
			.listVolumes()
			.then(resp => _.map(resp.Volumes, 'Name'));
		const networksPromise = this.docker
			.listNetworks()
			.then(resp => _.map(resp, 'Id'));

		const [containers, images, volumes, networks] = await Bluebird.all([
			containersPromise,
			imagesPromise,
			volumesPromise,
			networksPromise,
		]);
		return new EngineSnapshotRecord(
			new EngineSnapshot(containers, images, volumes, networks),
			new Date(),
		);
	}

	private async collectContainerResources(
		nameOrId: string,
	): Promise<EngineSnapshot> {
		const inspectInfo = await this.docker.getContainer(nameOrId).inspect();
		return new EngineSnapshot(
			[inspectInfo.Id],
			[inspectInfo.Image],
			inspectInfo.Mounts.filter(m => m.Name != null).map(m => m.Name!),
			_.map(inspectInfo.NetworkSettings.Networks, n => n.NetworkID),
		);
	}

	// Determine what engine objects are linked to our own container.
	private async collectOwnResources(): Promise<EngineSnapshot> {
		try {
			return this.collectContainerResources(
				this.containerId || SUPERVISOR_CONTAINER_NAME_FALLBACK,
			);
		} catch (e) {
			if (this.containerId !== undefined) {
				// Inspect operation fails (container ID is out of sync?).
				const fallback = SUPERVISOR_CONTAINER_NAME_FALLBACK;
				log.warn(
					'Supervisor container resources cannot be obtained by container ID. ' +
						`Using '${fallback}' name instead.`,
					e.message,
				);
				return this.collectContainerResources(fallback);
			}
			throw new SupervisorContainerNotFoundError(e);
		}
	}

	private async cleanEngineSnapshots() {
		await this.db.models('engineSnapshot').delete();
	}

	// Store engine snapshot data in the local database.
	public async storeEngineSnapshot(record: EngineSnapshotRecord) {
		const timestamp = record.timestamp.toISOString();
		log.debug(
			`Storing engine snapshot in the database. Timestamp: ${timestamp}`,
		);
		await this.cleanEngineSnapshots();
		await this.db.models('engineSnapshot').insert({
			snapshot: JSON.stringify(record.snapshot),
			timestamp,
		});
	}

	// Ensures an error is thrown id timestamp string cannot be parsed.
	// Date.parse may both throw or return NaN depending on a case.
	private static parseTimestamp(input: string): Date {
		const ms = Date.parse(input);
		if (isNaN(ms)) {
			throw new Error('bad date string - got Nan parsing it');
		}
		return new Date(ms);
	}

	// Read the latest stored snapshot from the database.
	public async retrieveLatestSnapshot(): Promise<EngineSnapshotRecord | null> {
		const r = await this.db
			.models('engineSnapshot')
			.select()
			.orderBy('rowid', 'DESC')
			.first();

		if (!r) {
			return null;
		}
		try {
			return new EngineSnapshotRecord(
				EngineSnapshot.fromJSON(r.snapshot),
				LocalModeManager.parseTimestamp(r.timestamp),
			);
		} catch (e) {
			// Some parsing error happened. Ensure we add data details to the error description.
			throw new Error(
				`Cannot parse snapshot data ${JSON.stringify(r)}.` +
					`Original message: [${e.message}].`,
			);
		}
	}

	private async removeLocalModeArtifacts(objects: EngineSnapshot) {
		log.debug(`Going to delete the following objects: ${objects}`);

		// Delete engine objects. We catch every deletion error, so that we can attempt other objects deletions.
		await Bluebird.map(objects.containers, cId => {
			return this.docker
				.getContainer(cId)
				.remove({ force: true })
				.catch(e => log.error(`Unable to delete container ${cId}`, e));
		});
		await Bluebird.map(objects.images, iId => {
			return this.docker
				.getImage(iId)
				.remove({ force: true })
				.catch(e => log.error(`Unable to delete image ${iId}`, e));
		});
		await Bluebird.map(objects.networks, nId => {
			return this.docker
				.getNetwork(nId)
				.remove()
				.catch(e => log.error(`Unable to delete network ${nId}`, e));
		});
		await Bluebird.map(objects.volumes, vId => {
			return this.docker
				.getVolume(vId)
				.remove()
				.catch(e => log.error(`Unable to delete volume ${vId}`, e));
		});

		// Remove any local mode state added to the database.
		await this.db
			.models('app')
			.del()
			.where({ source: 'local' })
			.catch(e =>
				log.error('Cannot delete local app entries in the database', e),
			);
	}

	// Handle local mode state change.
	// Input parameter is a target (new) state.
	public async handleLocalModeStateChange(local: boolean) {
		try {
			const currentRecord = await this.collectEngineSnapshot();
			if (local) {
				return await this.storeEngineSnapshot(currentRecord);
			}

			const previousRecord = await this.retrieveLatestSnapshot();
			if (!previousRecord) {
				log.info('Previous engine snapshot was not stored. Skipping cleanup.');
				return;
			}

			const supervisorResources = await this.collectOwnResources();
			log.debug(`${supervisorResources} are linked to current supervisor`);

			log.debug(
				`Leaving local mode and cleaning up objects since ${previousRecord.timestamp.toISOString()}`,
			);
			await this.removeLocalModeArtifacts(
				currentRecord.snapshot
					.diff(previousRecord.snapshot)
					.diff(supervisorResources),
			);
			await this.cleanEngineSnapshots();
		} catch (e) {
			log.error(
				`Problems managing engine state on local mode switch. Local mode: ${local}.`,
				e,
			);
		} finally {
			log.debug('Handling of local mode switch is completed');
		}
	}

	// Returns a promise to await local mode switch completion started previously.
	public async switchCompletion() {
		if (this.switchInProgress == null) {
			return;
		}
		await this.switchInProgress;
	}
}

export default LocalModeManager;
