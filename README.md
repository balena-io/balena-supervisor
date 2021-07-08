# balenaSupervisor

balenaSupervisor is [balena](https://balena.io)'s on-device
agent, responsible for monitoring and applying changes to an
IoT device. It communicates with balenaCloud and handles the
lifecycle of an IoT application.

Using the [balenaEngine](https://balena.io/engine)'s (our
IoT-centric container engine) remote API, balenaSupervisor
will install, start, stop and monitor IoT applications,
delivered and ran as [OCI](https://www.opencontainers.org/)
compliant containers.

balenaSupervisor is developed using Node.js.

## Contributing

If you're interested in contributing, that's awesome!

> Contributions are not only pull requests! Bug reports and
> feature requests are also extremely value additions.

### Issues

Feature request and bug reports should be submitted via
issues. One of the balenaSupervisor team will reply and work
with the community to plan a route forward. Although we may
never implement the feature, taking the time to let us know
what you as a user would like to see really helps our
decision making processes!

### Pull requests

Here's a few guidelines to make the process easier for everyone involved.

- Every PR _should_ have an associated issue, and the PR's opening comment should say "Fixes #issue" or "Closes #issue".
- We use [Versionist](https://github.com/resin-io/versionist) to manage versioning (and in particular, [semantic versioning](https://semver.org)) and generate the changelog for this project.
- At least one commit in a PR should have a `Change-Type: type` footer, where `type` can be `patch`, `minor` or `major`. The subject of this commit will be added to the changelog.
- Commits should be squashed as much as makes sense.
- Commits should be signed-off (`git commit -s`)

## Setup

To get the codebase setup on your development machine follow these steps. For running the supervisor on a device see [Developing the supervisor](#developing-the-supervisor) or [Using balenaOS-in-container](#using-balenaos-in-container).

```sh
# Clone the repo
git clone git@github.com:balena-os/balena-supervisor.git

# Install dependencies
npm ci
```

We explicitly use `npm ci` over `npm install` to ensure the correct package versions are installed. More documentation for this can be found [here](https://docs.npmjs.com/cli/ci) on the npm cli docs.

You're now ready to start developing. If you get stuck at some point please reference the [troubleshooting](#troubleshooting) section before creating an issue.

## Developing the supervisor

By far the most convenient way to develop the supervisor is
to download a development image of balenaOS from the
dashboard, and run it on a device you have to hand. You can
then use the local network to sync changes using
[livepush](http://github.com/balena-io-modules/livepush) and
`npm run sync`.

If you do not have a device available, it's possible to run
a supervisor locally, using
[balenaOS-in-container](https://github.com/balena-os/balenaos-in-container).
These steps are detailed below.

### Sync

Example:

```bash
$ npm run sync -- d19baeb.local

> balena-supervisor@10.11.3 sync /home/cameron/Balena/modules/balena-supervisor
> ts-node --project tsconfig.json sync/sync.ts "d19baeb.local"

Step 1/23 : ARG ARCH=amd64
Step 2/23 : ARG NODE_VERSION=10.19.0
Step 3/23 : FROM balenalib/$ARCH-alpine-supervisor-base:3.11 as BUILD
...

```

> Note: For .local resolution to work you must have installed
> and enabled MDNS. Alternatively you can use the device's
> local IP.

Sync will first run a new build on the target device (or
balenaOS container), after livepush has processed the
livepush specific commands and will start the new supervisor
image on device.

The supervisor logs are then streamed back from the device,
and livepush will then watch for changes on the local FS,
and sync any relevant file changes to the running supervisor
container. It will then decide if the container should be
restarted, or let nodemon handle the changes.

### Debugging

Using live push the supervisor starts with remote debugging enabled via the --inspect flag. Use Chrome dev tools, or your IDE to [start a debugging session](https://nodejs.org/en/docs/guides/debugging-getting-started/#inspector-clients).

Connect your debugger to `<device-local-ip>:9229`

### Using balenaOS-in-container

This process will allow you to run a development instance of the supervisor on your local computer. It is not recommended for production scenarios, but allows someone developing on the supervisor to test changes quickly.
The supervisor is run inside a balenaOS instance running in a container, so effectively it's a Docker-in-Docker instance (or more precisely, [balenaEngine](https://github.com/resin-os/balena-engine)-in-Docker).

#### Set up `config.json`

To configure the supervisor, you'll need a `tools/dind/config.json` file. There's two options on how to get this file:

- Log in to the [balenaCloud dashboard](https://dashboard.balena-cloud.com), create or select an application, click "Add device" and on the Advanced section select "Download configuration file only". Make sure you use an x86 or amd64 device type for your application, for example Intel NUC.
- Install the balena CLI with `npm install -g balena-cli`, then login with `balena login` and finally run `balena config generate --app <appName> -o config.json` (choose the default settings whenever prompted).

The `config.json` file should look something like this:

(Please note we've added comments to the JSON for better explanation - the actual file should be valid json _without_ such comments)

```
{
	"applicationId": "2167", /* Id of the app this supervisor will run */
	"apiKey": "supersecretapikey", /* The API key to provision the device on the balena API */
	"deviceType": "intel-nuc", /* The device type corresponding to the test application */
	"apiEndpoint": "https://api.balena-cloud.com", /* Endpoint for the balena API */
	"deltaEndpoint": "https://delta.balena-cloud.com", /* Endpoint for the delta server to download Docker binary diffs */
	"listenPort": 48484, /* Listen port for the supervisor API */
	"mixpanelToken": "aaaaaaaaaaaaaaaaaaaaaaaaaa", /* Mixpanel token to report events */
}
```

Additionally, the `uuid`, `registered_at` and `deviceId` fields will be added by the supervisor upon registration with the balena API. Other fields may be present (the format has evolved over time and will likely continue to do so) but they are not used by the supervisor.

#### Start the supervisor instance

Ensure your kernel supports aufs (in Ubuntu, install `linux-image-extra-$(uname -r)`) and the `aufs` module is loaded (if necessary, run `sudo modprobe aufs`).

```bash
./dindctl run --image balena/amd64-supervisor:master
```

This will setup a Docker-in-Docker instance with an image that runs the supervisor image. You can replace `:master` for a specific tag (see the [tags in Dockerhub](https://hub.docker.com/r/balena/amd64-supervisor/tags/)) to run
a supervisor from a branch or specific version. The script will pull the image if it is not already available in your
local Docker instance.

If you want to develop and test your changes, you can run:

```bash
./dindctl run --image balena/amd64-supervisor:master --mount-dist
```

Note: Using `--mount-dist` requires a Node.js 6.x installed on your computer.

This will mount the ./dist folder into the supervisor container and build the code before starting the instance, so that any changes you make can be added to the running supervisor with:

```bash
./dindctl refresh
```

#### Testing with preloaded apps

To test preloaded apps, run `balena preload` (see the [balena CLI docs](https://docs.balena.io/tools/cli/#preload-60-image-62-) on an OS image for the app you are testing with. Then copy the `apps.json` file from the `resin-data` partition into `tools/dind/apps.json`.

This file has a format equivalent to the `local` part of the target state endpoint on the balena API.

Make sure the `config.json` file doesn't have uuid, registered_at or deviceId populated from a previous run.

Then run the supervisor like this:

```bash
./dindctl run --image balena/amd64-supervisor:master --preload
```

This will make the Docker-in-Docker instance pull the image specified in `apps.json` before running the supervisor, simulating a preloaded balenaOS image.

#### View the supervisor's logs

```bash
./dindctl logs
```

This will show the output of `journalctl` inside the Docker-in-Docker container. You can pass
additional options, for instance, to see the logs from the supervisor service:

```bash
./dindctl logs -fn 100 -u balena-supervisor
```

#### Stop the supervisor

```bash
./dindctl stop
```

This will stop the container and remove it, also removing
its volumes.

## Developing using a production image or device

A production balena image does not have an open docker
socket, required for livepush to work. In this situation,
the `tools/sync.js` script can be used. Note that this
process is no longer actively developed, so your mileage may
vary.

Bug reports and pull requests are still accepted for changes
to `sync.js`, but the balenaSupervisor team will focus on
`npm run sync` in the future.

## Building

### Docker images

To build a docker image for amd64 targets, it's as simple
as:

```bash
docker build . -t my-supervisor
```

For other architectures, one must use the script
`automation/build.sh`. This is because of emulation specific
changes we have made to our base images to allow
cross-compilation.

For example, to build for the raspberry pi 3:

```sh
ARCH=armv7hf automation/build.sh
```

This will produce an image `balena/armv7hf-supervisor:<git branch name>`.
To avoid using the branch name, you can set a `TAG` variable
in your shell, before using the build script.

> Available architectures: `amd64`, `i386`, `aarch64`,
> `armv7hf` and `rpi`

## Testing

You can run some unit tests with:

```
npm test
```

The supervisor runs on Node v12.16.2, so using that specific
version will ensure tests run in the same environment as
production.

Alternatively, tests will be run when building the image,
which ensures that the environment is exactly the same.

#### Running specific tests quickly

You can run specific tests quickly with the `test:fast` script by matching with test suites (describe) or test cases (it) using a string or regexp:

```sh
npm run test:fast -- --grep spawnJournalctl

npm run test:fast -- --grep "detect a V2 delta"

npm run test:fast -- --grep (GET|POST|PUT|DELETE)
```

The --grep option, when specified, will trigger mocha to only run tests matching the given pattern which is internally compiled to a RegExp.

## Troubleshooting

Make sure you are running at least:

```sh
node -v       # >= 12.16.2
npm -v        # >= 6.14.4
git --version # >= 2.13.0
```

Also, ensure you're installing dependencies with `npm ci` as this will perform a clean install and guarantee the module versions specified are downloaded rather then installed which might attempt to upgrade!

## License

Copyright 2020 Balena Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
