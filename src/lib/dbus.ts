import { promisify } from 'util';
import * as dbus from 'dbus';
import { TypedError } from 'typed-error';

import log from './supervisor-console';

export class DbusError extends TypedError {}

let _dbus: dbus.DBusConnection;
let _getInterfacePromise: (...args: string[]) => Promise<dbus.DBusInterface>;

// Wrap bus & getInterface declarations to avoid import side effects
function getInterfaceAsync(...args: string[]) {
	if (!_dbus || !_getInterfacePromise) {
		_dbus = dbus.getBus('system');
		_getInterfacePromise = promisify(_dbus.getInterface).bind(_dbus);
	}
	return _getInterfacePromise(...args);
}

async function getSystemdInterface() {
	try {
		return await getInterfaceAsync(
			'org.freedesktop.systemd1',
			'/org/freedesktop/systemd1',
			'org.freedesktop.systemd1.Manager',
		);
	} catch (e) {
		throw new DbusError(e);
	}
}

export async function getLoginManagerInterface() {
	try {
		return await getInterfaceAsync(
			'org.freedesktop.login1',
			'/org/freedesktop/login1',
			'org.freedesktop.login1.Manager',
		);
	} catch (e) {
		throw new DbusError(e);
	}
}

async function startUnit(unitName: string) {
	const systemd = await getSystemdInterface();
	try {
		systemd.StartUnit(unitName, 'fail');
	} catch (e) {
		throw new DbusError(e);
	}
}

export async function restartService(serviceName: string) {
	const systemd = await getSystemdInterface();
	try {
		systemd.RestartUnit(`${serviceName}.service`, 'fail');
	} catch (e) {
		throw new DbusError(e);
	}
}

export async function startService(serviceName: string) {
	return startUnit(`${serviceName}.service`);
}

export async function startSocket(socketName: string) {
	return startUnit(`${socketName}.socket`);
}

async function stopUnit(unitName: string) {
	const systemd = await getSystemdInterface();
	try {
		systemd.StopUnit(unitName, 'fail');
	} catch (e) {
		throw new DbusError(e);
	}
}

export async function stopService(serviceName: string) {
	return stopUnit(`${serviceName}.service`);
}

export async function stopSocket(socketName: string) {
	return stopUnit(`${socketName}.socket`);
}

export async function enableService(serviceName: string) {
	const systemd = await getSystemdInterface();
	try {
		systemd.EnableUnitFiles([`${serviceName}.service`], false, false);
	} catch (e) {
		throw new DbusError(e);
	}
}

export async function disableService(serviceName: string) {
	const systemd = await getSystemdInterface();
	try {
		systemd.DisableUnitFiles([`${serviceName}.service`], false);
	} catch (e) {
		throw new DbusError(e);
	}
}

export const reboot = async () =>
	setTimeout(async () => {
		try {
			const logind = await getLoginManagerInterface();
			logind.Reboot(false);
		} catch (e) {
			log.error(`Unable to reboot: ${e}`);
		}
	}, 1000);

export const shutdown = async () =>
	setTimeout(async () => {
		try {
			const logind = await getLoginManagerInterface();
			logind.PowerOff(false);
		} catch (e) {
			log.error(`Unable to shutdown: ${e}`);
		}
	}, 1000);

async function getUnitProperty(unitName: string, property: string) {
	const systemd = await getSystemdInterface();
	return new Promise((resolve, reject) => {
		systemd.GetUnit(unitName, async (err: Error, unitPath: string) => {
			if (err) {
				return reject(err);
			}
			const iface = await getInterfaceAsync(
				'org.freedesktop.systemd1',
				unitPath,
				'org.freedesktop.DBus.Properties',
			);

			iface.Get(
				'org.freedesktop.systemd1.Unit',
				property,
				(e: Error, value: unknown) => {
					if (e) {
						return reject(new DbusError(e));
					}
					resolve(value);
				},
			);
		});
	});
}

export function serviceActiveState(serviceName: string) {
	return getUnitProperty(`${serviceName}.service`, 'ActiveState');
}
