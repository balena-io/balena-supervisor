import * as childProcess from 'child_process';
import { SpawnOptions, ChildProcess } from 'child_process';
import * as constants from './constants';

/**
 * Spawn command on the host OS
 *
 * This function performs run a command through chroot to the
 * host OS root mountpoint. The function arguments are the same
 * as https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
 */
export function spawn(
	cmd: string,
	args: ReadonlyArray<string>,
	options?: SpawnOptions,
): ChildProcess {
	const baseargs = [constants.rootMountPoint, cmd];

	if (options) {
		return childProcess.spawn('chroot', baseargs.concat(args), options);
	} else {
		return childProcess.spawn('chroot', baseargs.concat(args));
	}
}
