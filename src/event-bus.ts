import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';
import { ConfigChangeMap } from './config';
import { SchemaTypeKey } from './config/schema-type';

export interface GlobalEvents {
	deviceProvisioned: void;
	configChanged: ConfigChangeMap<SchemaTypeKey>;
}

type GlobalEventEmitter = StrictEventEmitter<EventEmitter, GlobalEvents>;

export class GlobalEventBus extends (EventEmitter as new () => GlobalEventEmitter) {
	public constructor() {
		super();
	}
}

export const getInstance = _.once(() => new GlobalEventBus());
