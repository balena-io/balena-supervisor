export interface ComposeNetworkConfig {
	driver: string;
	driver_opts: Dictionary<string>;
	ipam: {
		driver: string;
		config: Array<
			Partial<{
				subnet: string;
				ip_range: string;
				gateway: string;
				aux_addresses: Dictionary<string>;
			}>
		>;
		options: Dictionary<string>;
	};
	enable_ipv6: boolean;
	internal: boolean;
	labels: Dictionary<string>;
}
export interface NetworkConfig {
	driver: string;
	ipam: {
		driver: string;
		config: Array<{
			subnet?: string;
			gateway?: string;
			ipRange?: string;
			auxAddress?: string;
		}>;
		options: { [optName: string]: string };
	};
	enableIPv6: boolean;
	internal: boolean;
	labels: { [labelName: string]: string };
	options: { [optName: string]: string };
}
