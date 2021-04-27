export interface LogType {
	eventName: string;
	humanName: string;
}

export const stopService: LogType = {
	eventName: 'Service kill',
	humanName: 'Killing service',
};
export const stopServiceSuccess: LogType = {
	eventName: 'Service stop',
	humanName: 'Killed service',
};
export const stopServiceNoop: LogType = {
	eventName: 'Service already stopped',
	humanName: 'Service is already stopped, removing container',
};
export const stopRemoveServiceNoop: LogType = {
	eventName: 'Service already stopped and container removed',
	humanName: 'Service is already stopped and the container removed',
};
export const stopServiceError: LogType = {
	eventName: 'Service stop error',
	humanName: 'Failed to kill service',
};

export const removeDeadService: LogType = {
	eventName: 'Remove dead container',
	humanName: 'Removing dead container',
};
export const removeDeadServiceError: LogType = {
	eventName: 'Remove dead container error',
	humanName: 'Error removing dead container',
};

export const downloadImage: LogType = {
	eventName: 'Docker image download',
	humanName: 'Downloading image',
};
export const downloadImageDelta: LogType = {
	eventName: 'Delta image download',
	humanName: 'Downloading delta for image',
};
export const downloadImageSuccess: LogType = {
	eventName: 'Image downloaded',
	humanName: 'Downloaded image',
};
export const downloadImageError: LogType = {
	eventName: 'Image download error',
	humanName: 'Failed to download image',
};

export const installService: LogType = {
	eventName: 'Service install',
	humanName: 'Installing service',
};
export const installServiceSuccess: LogType = {
	eventName: 'Service installed',
	humanName: 'Installed service',
};
export const installServiceError: LogType = {
	eventName: 'Service install error',
	humanName: 'Failed to install service',
};

export const deleteImage: LogType = {
	eventName: 'Image removal',
	humanName: 'Deleting image',
};
export const deleteImageSuccess: LogType = {
	eventName: 'Image removed',
	humanName: 'Deleted image',
};
export const deleteImageError: LogType = {
	eventName: 'Image removal error',
	humanName: 'Failed to delete image',
};
export const imageAlreadyDeleted: LogType = {
	eventName: 'Image already deleted',
	humanName: 'Image already deleted',
};
export const deltaStillProcessingError: LogType = {
	eventName: 'Delta still processing remotely.',
	humanName: 'Delta still processing remotely. Will retry...',
};

export const startService: LogType = {
	eventName: 'Service start',
	humanName: 'Starting service',
};
export const startServiceSuccess: LogType = {
	eventName: 'Service started',
	humanName: 'Started service',
};
export const startServiceError: LogType = {
	eventName: 'Service start error',
	humanName: 'Failed to start service',
};

export const updateService: LogType = {
	eventName: 'Service update',
	humanName: 'Updating service',
};
export const updateServiceError: LogType = {
	eventName: 'Service update error',
	humanName: 'Failed to update service',
};

export const serviceExit: LogType = {
	eventName: 'Service exit',
	humanName: 'Service exited',
};

export const serviceRestart: LogType = {
	eventName: 'Service restart',
	humanName: 'Restarting service',
};

export const updateServiceConfig: LogType = {
	eventName: 'Service config update',
	humanName: 'Updating config for service',
};
export const updateServiceConfigSuccess: LogType = {
	eventName: 'Service config updated',
	humanName: 'Updated config for service',
};
export const updateServiceConfigError: LogType = {
	eventName: 'Service config update error',
	humanName: 'Failed to update config for service',
};

export const createVolume: LogType = {
	eventName: 'Volume creation',
	humanName: 'Creating volume',
};

export const createVolumeError: LogType = {
	eventName: 'Volume creation error',
	humanName: 'Error creating volume',
};

export const removeVolume: LogType = {
	eventName: 'Volume removal',
	humanName: 'Removing volume',
};

export const removeVolumeError: LogType = {
	eventName: 'Volume removal error',
	humanName: 'Error removing volume',
};

export const createNetwork: LogType = {
	eventName: 'Network creation',
	humanName: 'Creating network',
};

export const createNetworkError: LogType = {
	eventName: 'Network creation error',
	humanName: 'Error creating network',
};

export const removeNetwork: LogType = {
	eventName: 'Network removal',
	humanName: 'Removing network',
};

export const removeNetworkError: LogType = {
	eventName: 'Network removal error',
	humanName: 'Error removing network',
};

export const hostExtensionUpdate: LogType = {
	eventName: 'Host extensions update',
	humanName: 'Updating host extensions',
};

export const hostExtensionUpdateSuccess: LogType = {
	eventName: 'Host extensions updated',
	humanName: 'Updated extensions will be available on reboot',
};

export const hostExtensionUpdateError: LogType = {
	eventName: 'Host extensions update error',
	humanName: 'Failed to update host extensions',
};
