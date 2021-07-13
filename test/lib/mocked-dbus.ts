import * as dbus from 'dbus';
import { DBusError, DBusInterface } from 'dbus';
import { stub, SinonStub } from 'sinon';

const serviceInterfaces: any = {
	'org.freedesktop.systemd1': {
		Get: (
			_unitName: string,
			_property: string,
			getCb: (err: null | Error, value: unknown) => void,
		) => {
			getCb(null, 'this is the value');
		},
		GetUnit: (
			_unitName: string,
			getUnitCb: (err: null | Error, unitPath: string) => void,
		) => {
			getUnitCb(null, 'this is the unit path');
		},
		StartUnit: (_unitName: string) => {
			// noop
		},
		RestartUnit: (_unitName: string, _mode: string) => {
			// noop
		},
		StopUnit: (_unitName: string, _mode: string) => {
			// noop
		},
	},
	'org.freedesktop.login1': {
		Reboot: (_isInteractive: boolean) => {
			// noop
		},
		PowerOff: (_isInteractive: boolean) => {
			// noop
		},
	},
};

let dbusStub: SinonStub;

/**
 * Mock dbus.getBus as sinon stub
 */
export function mock() {
	console.log('🚌  Mocking dbus...');

	dbusStub = stub(dbus, 'getBus').returns({
		getInterface: (
			serviceName: string,
			_objectPath: string,
			_interfaceName: string,
			interfaceCb: (err: null | DBusError, iface: DBusInterface) => void,
		) => {
			interfaceCb(null, serviceInterfaces[serviceName]);
		},
	} as any);

	return dbusStub;
}

/**
 * Unmock dbus.getBus sinon stub
 */
export function unmock() {
	try {
		dbusStub.restore();
	} catch {
		// noop - not a stub
	}
}
