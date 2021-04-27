import * as Bluebird from 'bluebird';
import * as lockFileLib from 'lockfile';
import * as _ from 'lodash';
import { fs } from 'mz';
import * as path from 'path';
import * as Lock from 'rwlock';

import * as constants from './constants';
import { ENOENT, UpdatesLockedError } from './errors';

type asyncLockFile = typeof lockFileLib & {
	unlockAsync(path: string): Bluebird<void>;
	lockAsync(path: string): Bluebird<void>;
};
const lockFile = Bluebird.promisifyAll(lockFileLib) as asyncLockFile;
export type LockCallback = (
	appId: number,
	opts: { force: boolean },
	fn: () => PromiseLike<void>,
) => Bluebird<void>;

function baseLockPath(appId: number): string {
	return path.join('/tmp/balena-supervisor/services', appId.toString());
}

export function lockPath(appId: number, serviceName: string): string {
	return path.join(baseLockPath(appId), serviceName);
}

function lockFilesOnHost(appId: number, serviceName: string): string[] {
	return ['updates.lock', 'resin-updates.lock'].map((filename) =>
		path.join(constants.rootMountPoint, lockPath(appId, serviceName), filename),
	);
}

const locksTaken: { [lockName: string]: boolean } = {};

// Try to clean up any existing locks when the program exits
process.on('exit', () => {
	for (const lockName of _.keys(locksTaken)) {
		try {
			lockFile.unlockSync(lockName);
		} catch (e) {
			// Ignore unlocking errors
		}
	}
});

type LockFn = (key: string | number) => Bluebird<() => void>;
const locker = new Lock();
export const writeLock: LockFn = Bluebird.promisify(locker.async.writeLock, {
	context: locker,
});
export const readLock: LockFn = Bluebird.promisify(locker.async.readLock, {
	context: locker,
});

function dispose(release: () => void): Bluebird<void> {
	return Bluebird.map(_.keys(locksTaken), (lockName) => {
		delete locksTaken[lockName];
		return lockFile.unlockAsync(lockName);
	})
		.finally(release)
		.return();
}

/**
 * Try to take the locks for an application. If force is set, it will remove
 * all existing lockfiles before performing the operation
 */
export function lock(
	appId: number | null,
	{ force = false }: { force: boolean },
	fn: () => PromiseLike<void>,
): Bluebird<void> {
	const takeTheLock = () => {
		if (appId == null) {
			return;
		}
		return writeLock(appId)
			.tap((release: () => void) => {
				const lockDir = path.join(
					constants.rootMountPoint,
					baseLockPath(appId),
				);

				return Bluebird.resolve(fs.readdir(lockDir))
					.catchReturn(ENOENT, [])
					.mapSeries((serviceName) => {
						return Bluebird.mapSeries(
							lockFilesOnHost(appId, serviceName),
							(tmpLockName) => {
								return Bluebird.try(() => {
									if (force) {
										return lockFile.unlockAsync(tmpLockName);
									}
								})
									.then(() => lockFile.lockAsync(tmpLockName))
									.then(() => {
										locksTaken[tmpLockName] = true;
									})
									.catchReturn(ENOENT, undefined);
							},
						).catch((err) => {
							return dispose(release).throw(
								new UpdatesLockedError(`Updates are locked: ${err.message}`),
							);
						});
					});
			})
			.disposer(dispose);
	};

	const disposer = takeTheLock();
	if (disposer) {
		return Bluebird.using(disposer, fn);
	} else {
		return Bluebird.resolve(fn());
	}
}
