process.env.ROOT_MOUNTPOINT = './test/data';
process.env.BOOT_MOUNTPOINT = '/mnt/boot';
process.env.CONFIG_JSON_PATH = '/config.json';
process.env.CONFIG_MOUNT_POINT = './test/data/config.json';
process.env.DATABASE_PATH = './test/data/database.sqlite';
process.env.DATABASE_PATH_2 = './test/data/database2.sqlite';
process.env.DATABASE_PATH_3 = './test/data/database3.sqlite';

import * as fs from 'fs';

// Make sure they are no database files left over from
// previous runs
try {
	fs.unlinkSync(process.env.DATABASE_PATH);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_2);
} catch {
	/* noop */
}
try {
	fs.unlinkSync(process.env.DATABASE_PATH_3);
} catch {
	/* noop */
}
fs.writeFileSync(
	'./test/data/config.json',
	fs.readFileSync('./test/data/testconfig.json'),
);

import './lib/mocked-dockerode';
import './lib/mocked-iptables';
