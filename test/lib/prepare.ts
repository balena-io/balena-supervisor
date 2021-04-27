import * as fs from 'fs';
import * as db from '../../src/db';
import * as config from '../../src/config';

export = async function () {
	await db.initialized;
	await config.initialized;

	await db.transaction(async (trx) => {
		const result = await trx.raw(`
			SELECT name, sql
			FROM sqlite_master
			WHERE type='table'`);
		for (const r of result) {
			// We don't run the migrations again
			if (r.name !== 'knex_migrations') {
				await trx.raw(`DELETE FROM ${r.name}`);
			}
		}
		// The supervisor expects this value to already have
		// been pre-populated
		await trx('deviceConfig').insert({ targetValues: '{}' });
	});

	try {
		fs.unlinkSync(process.env.DATABASE_PATH_2!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.unlinkSync(process.env.DATABASE_PATH_3!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.unlinkSync(process.env.LED_FILE!);
	} catch (e) {
		/* ignore /*/
	}

	try {
		fs.writeFileSync(
			'./test/data/config.json',
			fs.readFileSync('./test/data/testconfig.json'),
		);
		fs.writeFileSync(
			'./test/data/config-apibinder.json',
			fs.readFileSync('./test/data/testconfig-apibinder.json'),
		);

		fs.writeFileSync(
			'./test/data/config-apibinder-offline.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline.json'),
		);
		fs.writeFileSync(
			'./test/data/config-apibinder-offline2.json',
			fs.readFileSync('./test/data/testconfig-apibinder-offline2.json'),
		);
		fs.writeFileSync(
			'./test/data/config-uuid.json',
			fs.readFileSync('./test/data/testconfig-uuid.json'),
		);
	} catch (e) {
		/* ignore /*/
	}

	// @ts-expect-error using private properties
	config.configJsonBackend.cache = await config.configJsonBackend.read();
	await config.generateRequiredFields();
};
