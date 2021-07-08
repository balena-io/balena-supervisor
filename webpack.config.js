const webpack = require('webpack');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const TerserWebpackPlugin = require('terser-webpack-plugin');

var externalModules = [
	'async_hooks',
	'sqlite3',
	'mysql2',
	'pg',
	'mariasql',
	'mssql',
	'mysql',
	'strong-oracle',
	'oracle',
	'oracledb',
	'pg-query-stream',
	'tedious',
	'dbus',
	/mssql\/.*/,
];

let requiredModules = [];
let maybeOptionalModules = [];
const lookForOptionalDeps = function (sourceDir) {
	// We iterate over the node modules and mark all optional dependencies as external
	var dirs = fs.readdirSync(sourceDir);
	for (let dir of dirs) {
		let packageJson = {};
		let internalNodeModules = path.join(sourceDir, dir, 'node_modules');
		if (fs.existsSync(internalNodeModules)) {
			lookForOptionalDeps(internalNodeModules);
		}
		try {
			packageJson = JSON.parse(
				fs.readFileSync(path.join(sourceDir, dir, '/package.json'), 'utf8'),
			);
		} catch (e) {
			continue;
		}
		if (packageJson.optionalDependencies != null) {
			maybeOptionalModules = maybeOptionalModules.concat(
				_.keys(packageJson.optionalDependencies),
			);
		}
		if (packageJson.dependencies != null) {
			requiredModules = requiredModules.concat(
				_.keys(packageJson.dependencies),
			);
		}
	}
};

lookForOptionalDeps('./node_modules');
externalModules.push(
	new RegExp(
		'^(' +
			_.reject(maybeOptionalModules, requiredModules)
				.map(_.escapeRegExp)
				.join('|') +
			')(/.*)?$',
	),
);

console.log('Using the following dependencies as external:', externalModules);

module.exports = function (env) {
	return {
		mode: env == null || !env.noOptimize ? 'production' : 'development',
		devtool: 'none',
		entry: './src/app.ts',
		output: {
			filename: 'app.js',
			path: path.resolve(__dirname, 'dist'),
		},
		resolve: {
			extensions: ['.js', '.ts', '.json'],
			alias: {
				// Use the es2018 build instead of the default es2015 build
				'pinejs-client-core': 'pinejs-client-core/es2018',
				'~': path.resolve(__dirname, './'),
			},
		},
		target: 'node',
		node: {
			__dirname: false,
		},
		optimization: {
			minimize: true,
			minimizer: [
				new TerserWebpackPlugin({
					terserOptions: {
						mangle: false,
						keep_classnames: true,
					},
				}),
			],
		},
		module: {
			rules: [
				{
					include: [
						new RegExp(
							_.escapeRegExp(path.join('knex', 'lib', 'migrate', 'sources')),
						),
					],
					use: require.resolve('./build-utils/hardcode-migrations'),
				},
				{
					test: new RegExp(
						_.escapeRegExp(path.join('JSONStream', 'index.js')) + '$',
					),
					use: require.resolve('./build-utils/fix-jsonstream'),
				},
				{
					test: /\.ts$|\.js$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader',
							options: {
								transpileOnly: true,
								configFile: 'tsconfig.release.json',
							},
						},
					],
				},
			],
		},
		externals: (_context, request, callback) => {
			for (let m of externalModules) {
				if (
					(typeof m === 'string' && m === request) ||
					(m instanceof RegExp && m.test(request))
				) {
					return callback(null, 'commonjs ' + request);
				} else if (typeof m !== 'string' && !(m instanceof RegExp)) {
					throw new Error('Invalid entry in external modules: ' + m);
				}
			}
			return callback();
		},
		plugins: [
			new ForkTsCheckerWebpackPlugin({
				async: false,
			}),
			new CopyWebpackPlugin({
				patterns: [
					{
						from: './build/migrations',
						to: 'migrations',
					},
				],
			}),
			new webpack.ContextReplacementPlugin(
				/\.\/migrations/,
				path.resolve(__dirname, 'build/migrations'),
			),
		],
	};
};
