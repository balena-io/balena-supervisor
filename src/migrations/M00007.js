export async function up(knex) {
	await knex.schema.table('app', (table) => {
		table.string('uuid');
		table.unique('uuid');
		table.boolean('isHost').defaultTo(false);
		table.string('releaseVersion');
	});
}

export async function down() {
	throw new Error('Not implemented');
}
