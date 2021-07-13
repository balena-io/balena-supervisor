# Configuration Variables

Configuration variables allow you to provide runtime configuration to the host OS and Supervisor. These variables all begin with `BALENA_` or the legacy prefix `RESIN_`. Beginning with `Supervisor v7.0.0`, a number of them automatically will be sent to the cloud on provision.

**Note:** Configuration variables defined in the dashboard will not apply to devices in local mode.

## Variable list

This list contains configuration variables that can be used with all balena devices, some of which will automatically appear for devices with Supervisor v7.0.0 and greater. While they may not automatically populate in the dashboard, most of these variables can still be used with older Supervisor versions, so be sure to check the _Valid from_ column:

| Name | Type | Reboots | Default | Description | Valid from |
| --- | --- | --- | --- | --- | --- |
| BALENA_SUPERVISOR_OVERRIDE_LOCK | boolean | false | false | Override any existing locks preventing application changes. | v1.0.0 |
| BALENA_SUPERVISOR_VPN_CONTROL | boolean | false | true | Enable / Disable VPN service on device. | v1.1.0 |
| BALENA_SUPERVISOR_CONNECTIVITY_CHECK | boolean | false | true | Enable / Disable VPN connectivity check | v1.3.0 |
| BALENA_SUPERVISOR_LOG_CONTROL | boolean | false | true | Enable / Disable logs being sent to the balena API | v1.3.0 |
| BALENA_SUPERVISOR_POLL_INTERVAL | integer | false | 900000 | Define the balena API poll interval in milliseconds. This interval will only matter if the device is not connected to the VPN at the time an update is pushed, or if BALENA_SUPERVISOR_INSTANT_UPDATE_TRIGGER is set to false. Starting from Supervisor v9.13.0, the Supervisor will use a random time between 0.5 and 1.5 times this poll interval each time it checks the balenaCloud API. The minimum value for this variable is defined by the balenaCloud backend, and may vary. | v1.3.0 |
| BALENA_SUPERVISOR_DELTA_REQUEST_TIMEOUT | integer | false | 30000 | Millisecond time within which an HTTP response containing delta metadata must be returned by the delta server. | v2.9.0 |
| BALENA_SUPERVISOR_LOCAL_MODE | boolean | false | false | Enable / Disable local mode. | v4.0.0 |
| BALENA_SUPERVISOR_DELTA_APPLY_TIMEOUT | integer | false | 0 | Millisecond time within which delta data will begin syncing to the local device. | v6.2.0 |
| BALENA_SUPERVISOR_DELTA_RETRY_COUNT | integer | false | 30 | Number of retry attempts for downloading deltas. | v6.2.0 |
| BALENA_SUPERVISOR_DELTA_RETRY_INTERVAL | integer | false | 10000 | Millisecond time before another delta download is attempted after failiure. | v6.2.0 |
| BALENA_SUPERVISOR_DELTA_VERSION | integer | false | 3 | Specifies the delta version to use which has different APIs and download algorithms. | v7.9.0 |
| BALENA_SUPERVISOR_PERSISTENT_LOGGING | boolean | true | false | Persists journal logs to disk so they will be available after a reboot event. | v7.15.0 |
| BALENA_SUPERVISOR_INSTANT_UPDATE_TRIGGER | boolean | false | true | Enable / Disable instant triggering of updates when a new release is deployed. If set to false, the device will ignore the notification that is triggered when the device's target state has changed. In this case, the device will rely on polling to apply updates. Coupled with a large BALENA_SUPERVISOR_POLL_INTERVAL, this allows spreading out updates in large fleets to avoid overloading local networks when there is a large number of devices at one location. | v9.13.0 |
| BALENA_HOST_FIREWALL_MODE | string | false | off | Toggle firewall modes between on, off, and auto. | v11.9.1 |
| BALENA_HOST_DISCOVERABILITY | boolean | false | true | Enable / Disable Avahi to run which will allow the device to respond to requests such as network scans. | v11.9.2 |
| BALENA_HOST_SPLASH_IMAGE | integer | true | /boot/splash/balena-logo-default.png | Allows changing splash screen on boot to user defined file from userspace. | v12.3.0 |
| BALENA_SUPERVISOR_HARDWARE_METRICS | boolean | false | true | Toggle hardware metrics reporting to the cloud, which occurs every 10 seconds when there are changes. Metrics include CPU utilization, CPU temperature, memory usage, and disk space. Useful for devices with bandwidth sensitivity. | v12.8.0 |
| BALENA_SUPERVISOR_DEVELOPMENT_MODE | boolean | false | true | Toggle development mode. | v12.9.5 |

---

In addition to these values, there may be some device-type specific configuration variables that can be set.

## Config.txt

> Supported boards: Any Raspberry Pi and balenaFin.

This device type utilizes a [`config.txt` file](https://www.raspberrypi.org/documentation/configuration/config-txt/README.md) of which we offer some values to be configured. The following values are not all the configurations found in the `config.txt` file and are just balena additions or edits to the OEM version.

| Name | Type | Reboots | Default | Description | Valid from |
| --- | --- | --- | --- | --- | --- |
| BALENA_HOST_CONFIG_dtoverlay | string | true | "vc4-fkms-v3d" | Allows loading [custom device tree overlays](https://github.com/raspberrypi/linux/blob/rpi-4.19.y/arch/arm/boot/dts/overlays/README). | v1.0.0 |
| BALENA_HOST_CONFIG_device_tree_overlay | string | true | "vc4-fkms-v3d" | Allows loading [custom device tree overlays](https://github.com/raspberrypi/linux/blob/rpi-4.19.y/arch/arm/boot/dts/overlays/README). | v1.0.0 |
| BALENA_HOST_CONFIG_dtparam | string | true | "i2c_arm=on","spi=on","audio=on" | Allows setting parameters for the default overlay. | v1.0.0 |
| BALENA_HOST_CONFIG_device_tree_param | string | true | "i2c_arm=on","spi=on","audio=on" | Allows setting parameters for the default overlay. | v1.0.0 |
| BALENA_HOST_CONFIG_disable_splash | integer | true | 1 | Enable / Disable the splash screen to display image on boot. | v1.0.0 |
| BALENA_HOST_CONFIG_gpu_mem | integer | true | 16 | Define device GPU memory in megabytes. | v1.0.0 |
| BALENA_HOST_CONFIG_gpio | string | true | undefined | Allows GPIO pins to be set to specific modes and values at boot time. See [here](https://www.raspberrypi.org/documentation/configuration/config-txt/gpio.md) for more. | v1.0.0 |

You can find more information on updating `config.txt` through configuration variables in our [Advanced Boot Configuration Guide](https://www.balena.io/docs/reference/os/advanced/).

## ConfigFS

> Supported boards: UP Board

This device type utilizes a `configFS` [file](https://lwn.net/Articles/148973/) interface that allows definition of arbitrary functions and configurations.

| Name | Type | Reboots | Default | Description | Valid from |
| --- | --- | --- | --- | --- | --- |
| BALENA_HOST_CONFIGFS_ssdt | string | true | undefined | Allows configuring a user defined SSDTs from userspace via the configfs interface. See [SSDT Overlays](https://www.kernel.org/doc/html/latest/admin-guide/acpi/ssdt-overlays.html#ssdt-overlays). | v10.9.2 |

## Extra-uEnv

> Supported boards: Nvidia Jetson Nano and TX2.

This device type utilizes a file which we created to proxy configurations to [extlinux.conf](https://wiki.syslinux.org/wiki/index.php?title=Config).

| Name | Type | Reboots | Default | Description | Valid from |
| --- | --- | --- | --- | --- | --- |
| BALENA_HOST_EXTLINUX_isolcpus | string | true | undefined | Allows to isolate CPU cores from kernel scheduler. See [kernel parameters](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html?highlight=isolcpu#the-kernel-s-command-line-parameters). | v7.10.0 |
| BALENA_HOST_EXTLINUX_fdt | string | true | undefined | Specify a filename with extension from userspace to use as DTB. See [Device Tree Binary](https://elinux.org/Jetson/TX2_DTB). | v11.9.0 |

## ODMDATA

> Supported boards: Nvidia Jetson TX2.

This device type utilizes a configurable hardware partition to set the mode for [UPHY lane assigment](https://docs.nvidia.com/jetson/l4t/index.html#page/Tegra%20Linux%20Driver%20Package%20Development%20Guide/adaptation_and_bringup_tx2.html#wwpID0E0NL0HA).

| Name | Type | Reboots | Default | Description | Valid from |
| --- | --- | --- | --- | --- | --- |
| BALENA_HOST_CONFIG_odmdata_configurations | integer | true | 2 | Select with mode to configure UPHY lanes. See [UPHY lane assignment](https://docs.nvidia.com/jetson/l4t/index.html#page/Tegra%20Linux%20Driver%20Package%20Development%20Guide/adaptation_and_bringup_tx2.html#wwpID0E0NL0HA). | v11.13.0 |
