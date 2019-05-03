export type LogMessage = Dictionary<any>;

export abstract class LogBackend {
	public unmanaged: boolean;
	public publishEnabled: boolean = true;

	public abstract log(message: LogMessage): void;
}

export default LogBackend;
