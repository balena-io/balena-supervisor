import * as _ from 'lodash';
import { inspect } from 'util';

import { TargetState } from '../types/state';
import { EnvVarObject, LabelObject } from './types';

import log from './supervisor-console';

export interface CheckIntOptions {
	positive?: boolean;
}

const ENV_VAR_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LABEL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9\.\-]*$/;
const NUMERALS_REGEX = /^-?[0-9]+\.?0*$/; // Allows trailing 0 decimals
const TRUTHY = ['1', 'true', true, 'on', 1];
const FALSEY = ['0', 'false', false, 'off', 0];

/**
 * checkInt
 *
 * Check an input string as a number, optionally specifying a requirement
 * to be positive
 */
export function checkInt(
	s: unknown,
	options: CheckIntOptions = {},
): number | undefined {
	// Check for non-numeric characters
	if (!NUMERALS_REGEX.test(s as string)) {
		return;
	}

	const i = Number(s);

	if (!Number.isInteger(i)) {
		return;
	}

	if (options.positive && i <= 0) {
		return;
	}

	return i;
}

/**
 * checkString
 *
 * Check that a string exists, and is not an empty string, 'null', or 'undefined'
 */
export function checkString(s: unknown): string | void {
	if (s == null || !_.isString(s) || _.includes(['null', 'undefined', ''], s)) {
		return;
	}

	return s;
}

/**
 * checkBooleanish
 *
 * Given an unknown value, determine if it can be evaluated to truthy/falsey.
 *
 */
export function checkBooleanish(v: unknown): boolean {
	return checkTruthy(v) || checkFalsey(v);
}

/**
 * checkTruthy
 *
 * Given an unknown value, determine if it evaluates to true.
 *
 */
export function checkTruthy(v: unknown): boolean {
	if (typeof v === 'string') {
		v = v.toLowerCase();
	}
	return TRUTHY.includes(v as any);
}

/**
 * checkFalsey
 *
 * Given an unknown value, determine if it evaluates to false.
 *
 */
export function checkFalsey(v: unknown): boolean {
	if (typeof v === 'string') {
		v = v.toLowerCase();
	}
	return FALSEY.includes(v as any);
}

/*
 * isValidShortText
 *
 * Check that the input string is definitely a string,
 * and has a length which is less than 255
 */
export function isValidShortText(t: unknown): boolean {
	return _.isString(t) && t.length <= 255;
}

/**
 * isValidEnv
 *
 * Given a env var object, check types and values for the keys
 * and values
 */
export function isValidEnv(obj: EnvVarObject): boolean {
	if (!_.isObject(obj)) {
		log.debug(
			`Non-object passed to validation.isValidEnv\nobj: ${inspect(obj)}`,
		);
		return false;
	}

	return _.every(obj, (val, key) => {
		if (!isValidShortText(key)) {
			log.debug(
				`Non-valid short text env var key passed to validation.isValidEnv\nKey: ${inspect(
					key,
				)}`,
			);
			return false;
		}

		if (!ENV_VAR_KEY_REGEX.test(key)) {
			log.debug(
				`Invalid env var key passed to validation.isValidEnv\nKey: ${inspect(
					key,
				)}`,
			);
			return false;
		}

		if (!_.isString(val)) {
			log.debug(
				`Non-string value passed to validation.isValidEnv\nValue: ${inspect(
					key,
				)}`,
			);
			return false;
		}
		return true;
	});
}

/**
 * isValidLabelsObject
 *
 * Given a labels object, test the types and values for validity
 */
export function isValidLabelsObject(obj: LabelObject): boolean {
	if (!_.isObject(obj)) {
		log.debug(
			`Non-object passed to validation.isValidLabelsObject\nobj: ${inspect(
				obj,
			)}`,
		);
		return false;
	}

	return _.every(obj, (val, key) => {
		if (!isValidShortText(key)) {
			log.debug(
				`Non-valid short text label key passed to validation.isValidLabelsObject\nKey: ${inspect(
					key,
				)}`,
			);
			return false;
		}

		if (!LABEL_NAME_REGEX.test(key)) {
			log.debug(
				`Invalid label name passed to validation.isValidLabelsObject\nKey: ${inspect(
					key,
				)}`,
			);
			return false;
		}

		if (!_.isString(val)) {
			log.debug(
				`Non-string value passed to validation.isValidLabelsObject\nValue: ${inspect(
					val,
				)}`,
			);
			return false;
		}

		return true;
	});
}

export function isValidDeviceName(name: string): boolean {
	// currently the only disallowed value in a device name is a newline
	const newline = name.indexOf('\n') !== -1;
	if (newline) {
		log.debug(
			'Newline found in device name. This is invalid and should be removed',
		);
	}
	return !newline;
}

function undefinedOrValidEnv(val: EnvVarObject): boolean {
	return val == null || isValidEnv(val);
}

/**
 * isValidDependentAppsObject
 *
 * Given a dependent apps object from a state endpoint, validate it
 *
 * TODO: Type the input
 */
export function isValidDependentAppsObject(apps: unknown): boolean {
	if (!_.isObject(apps)) {
		log.debug(
			'Non-object passed to validation.isValidDependentAppsObject\nApps:',
			inspect(apps),
		);
		return false;
	}

	return _.every(apps, (v, appId) => {
		const val: TargetState['dependent']['apps'][any] = _.defaults(_.clone(v), {
			config: undefined,
			environment: undefined,
			commit: undefined,
			image: undefined,
		});

		if (!isValidShortText(appId) || !checkInt(appId)) {
			log.debug(
				'Invalid appId passed to validation.isValidDependentAppsObject\nappId:',
				inspect(appId),
			);
			return false;
		}

		return _.conformsTo(val, {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					log.debug(
						'Invalid name passed to validation.isValidDependentAppsObject\nName:',
						inspect(n),
					);
					return false;
				}
				return true;
			},
			image: (i: any) => {
				if (val.commit != null && !isValidShortText(i)) {
					log.debug(
						'Non valid image passed to validation.isValidDependentAppsObject\nImage:',
						inspect(i),
					);
					return false;
				}
				return true;
			},
			commit: (c: any) => {
				if (c != null && !isValidShortText(c)) {
					log.debug(
						'invalid commit passed to validation.isValidDependentAppsObject\nCommit:',
						inspect(c),
					);
					return false;
				}
				return true;
			},
			config: (c: any) => {
				if (!undefinedOrValidEnv(c)) {
					log.debug(
						'Invalid config passed to validation.isValidDependentAppsObject\nConfig:',
						inspect(c),
					);
					return false;
				}
				return true;
			},
			environment: (e: any) => {
				if (!undefinedOrValidEnv(e)) {
					log.debug(
						'Invalid environment passed to validation.isValidDependentAppsObject\nEnvironment:',
						inspect(e),
					);
					return false;
				}
				return true;
			},
		});
	});
}

function isValidService(service: any, serviceId: string): boolean {
	if (!isValidShortText(serviceId) || !checkInt(serviceId)) {
		log.debug(
			'Invalid service id passed to validation.isValidService\nService ID:',
			inspect(serviceId),
		);
		return false;
	}

	return _.conformsTo(service, {
		serviceName: (n: any) => {
			if (!isValidShortText(n)) {
				log.debug(
					'Invalid service name passed to validation.isValidService\nService Name:',
					inspect(n),
				);
				return false;
			}
			return true;
		},
		image: (i: any) => {
			if (!isValidShortText(i)) {
				log.debug(
					'Invalid image passed to validation.isValidService\nImage:',
					inspect(i),
				);
				return false;
			}
			return true;
		},
		environment: (e: any) => {
			if (!isValidEnv(e)) {
				log.debug(
					'Invalid env passed to validation.isValidService\nEnvironment:',
					inspect(e),
				);
				return false;
			}
			return true;
		},
		imageId: (i: any) => {
			if (checkInt(i) == null) {
				log.debug(
					'Invalid image id passed to validation.isValidService\nImage ID:',
					inspect(i),
				);
				return false;
			}
			return true;
		},
		labels: (l: any) => {
			if (!isValidLabelsObject(l)) {
				log.debug(
					'Invalid labels object passed to validation.isValidService\nLabels:',
					inspect(l),
				);
				return false;
			}
			return true;
		},
	});
}

/**
 * isValidAppsObject
 *
 * Given an apps object from the state endpoint, validate the fields and
 * return whether it's valid.
 *
 * TODO: Type the input correctly
 */
export function isValidAppsObject(obj: any): boolean {
	if (!_.isObject(obj)) {
		log.debug(
			'Invalid object passed to validation.isValidAppsObject\nobj:',
			inspect(obj),
		);
		return false;
	}

	return _.every(obj, (v, uuid) => {
		if (!isValidShortText(uuid)) {
			log.debug(
				'Invalid UUID passed to validation.isValidAppsObject\nUUID:',
				inspect(uuid),
			);
			return false;
		}

		// TODO: Remove this partial and validate the extra fields
		const val: Partial<TargetState['local']['apps'][any]> = _.defaults(
			_.clone(v),
			{ releaseId: undefined },
		);

		return _.conformsTo(val, {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					log.debug(
						'Invalid service name passed to validation.isValidAppsObject\nName:',
						inspect(n),
					);
					return false;
				}
				return true;
			},
			appId: (id: any) => {
				if (id != null && checkInt(id) == null) {
					log.debug(
						'Invalid appId passed to validation.isValidAppsObject\nApp ID',
						inspect(id),
					);
					return false;
				}
				return true;
			},
			releaseId: (r: any) => {
				if (r != null && checkInt(r) == null) {
					log.debug(
						'Invalid releaseId passed to validation.isValidAppsObject\nRelease ID',
						inspect(r),
					);
					return false;
				}
				return true;
			},
			services: (s: any) => {
				if (!_.isObject(s)) {
					log.debug(
						'Non-object service passed to validation.isValidAppsObject\nServices:',
						inspect(s),
					);
					return false;
				}

				return _.every(s, (svc, svcId) => {
					if (!isValidService(svc, svcId)) {
						log.debug(
							'Invalid service object passed to validation.isValidAppsObject\nService:',
							inspect(svc),
						);
						return false;
					}
					return true;
				});
			},
		});
	});
}

/**
 * isValidDependentDevicesObject
 *
 * Validate a dependent devices object from the state endpoint.
 */
export function isValidDependentDevicesObject(devices: any): boolean {
	if (!_.isObject(devices)) {
		log.debug(
			'Non-object passed to validation.isValidDependentDevicesObject\nDevices:',
			inspect(devices),
		);
		return false;
	}

	return _.every(devices, (val, uuid) => {
		if (!isValidShortText(uuid)) {
			log.debug(
				'Invalid UUID passed to validation.isValidDependentDevicesObject\nUUID:',
				inspect(uuid),
			);
			return false;
		}

		return _.conformsTo(val as TargetState['dependent']['devices'][any], {
			name: (n: any) => {
				if (!isValidShortText(n)) {
					log.debug(
						'Invalid device name passed to validation.isValidDependentDevicesObject\nName:',
						inspect(n),
					);
					return false;
				}
				return true;
			},
			apps: (a: any) => {
				if (!_.isObject(a)) {
					log.debug(
						'Invalid apps object passed to validation.isValidDependentDevicesObject\nApps:',
						inspect(a),
					);
					return false;
				}

				if (_.isEmpty(a)) {
					log.debug(
						'Empty object passed to validation.isValidDependentDevicesObject',
					);
					return false;
				}

				return _.every(
					a as TargetState['dependent']['devices'][any]['apps'],
					(app) => {
						app = _.defaults(_.clone(app), {
							config: undefined,
							environment: undefined,
						});
						return _.conformsTo(app, {
							config: (c: any) => {
								if (!undefinedOrValidEnv(c)) {
									log.debug(
										'Invalid config passed to validation.isValidDependentDevicesObject\nConfig:',
										inspect(c),
									);
									return false;
								}
								return true;
							},
							environment: (e: any) => {
								if (!undefinedOrValidEnv(e)) {
									log.debug(
										'Invalid environment passed to validation.isValidDependentDevicesObject\nConfig:',
										inspect(e),
									);
									return false;
								}
								return true;
							},
						});
					},
				);
			},
		});
	});
}

/**
 * validStringOrUndefined
 *
 * Ensure a string is either undefined, or a non-empty string
 */
export function validStringOrUndefined(s: string | undefined): boolean {
	return _.isUndefined(s) || (_.isString(s) && !_.isEmpty(s));
}

/**
 * validStringOrUndefined
 *
 * Ensure an object is either undefined or an actual object
 */
export function validObjectOrUndefined(o: object | undefined): boolean {
	return _.isUndefined(o) || _.isObject(o);
}
