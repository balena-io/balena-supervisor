import * as host from './host-utils';
import log from './supervisor-console';

export function spawnJournalctl(opts: {
	all: boolean;
	follow: boolean;
	count?: number | 'all';
	unit?: string;
	containerId?: string;
	format: string;
	filterString?: string;
	since?: number;
}) {
	const args: string[] = [];
	if (opts.all) {
		args.push('-a');
	}
	if (opts.follow) {
		args.push('--follow');
	}
	if (opts.unit != null) {
		args.push('-u');
		args.push(opts.unit);
	}
	if (opts.containerId != null) {
		args.push('-t');
		args.push(opts.containerId);
	}
	if (opts.count != null) {
		args.push('-n');
		args.push(opts.count.toString());
	}
	if (opts.since != null) {
		args.push('-S');
		args.push(
			new Date(opts.since)
				.toISOString()
				.replace(/T/, ' ') // replace T with a space
				.replace(/\..+/, ''), // delete the dot and everything after
		);
	}
	args.push('-o');
	args.push(opts.format);

	if (opts.filterString) {
		args.push(opts.filterString);
	}

	log.debug('Spawning journald with: chroot ', args.join(' '));

	return host.spawn('journalctl', args, { stdio: 'pipe' });
}
