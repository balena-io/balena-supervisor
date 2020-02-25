# Device State Engine

The Device State engine, implemented by the `DeviceState` class, is one of the main models within the supervisor's code. It keeps representations of the device's current and target states, and implements the functions that bring the current state to match what is specified in the target.

## Construction and initialization

As in several other models in the supervisor, we separate construction and initialization since the latter can involve changing the device's state (e.g. making calls to docker/balenaEngine or modifying configuration), and we want construction to be as pure as possible. The constructor creates all of the models that are contained by the DeviceState object, but initialization is done by the `init` function that is called at a later time.

The constructor takes `@db`, `@config`, `@eventTracker`, and `@logger` objects, but doesn't require them to be initialized at that time. When `init` is called though, it is expected that these models will be ready to be used.

The initialization steps are as follows:

1) We set up listeners for configuration change events, to change behaviors of the supervisor if needed, or to update the current state e.g. if logging is turned off, if the supervisor's apikey changes, or if the update interval is updated.
2) We initialize the ApplicationManager, which will initialize logging from container output, and cleanup/normalise other things like for instance cleaning up the images table in the database.
3) We use `saveInitialConfig` to ensure device configuration from before the supervisor's first run is preserved. For instance, any config.txt entries that existed before the supervisor runs for the first time will be treated as part of the target state to avoid overwriting them. (Later, the APIBinder will use this to actually create configuration variables on the API and really make them part of the target state)
4) We initialize the network checks (for connectivity and IP address)
5) We initialize the local representation of the current state, with the values that will be reported to the API when the APIBinder starts
6) We load preloaded apps if we have to. This happens always if the device hasn't been provisioned (to allow using apps.json as a way to update unmanaged devices) or if the target state hasn't been set by anything else yet.
7) We start applying the target state (which will not change anything if the current state already matches the target state)

## Events

The DeviceState object is an EventEmitter, and emits two possible events:
* `'change'`, triggered every time there is a change in the current state. This is used by the APIBinder to trigger reporting the current state to the balena API.
* `'shutdown'`, triggered when the device is about to be rebooted or shut down. This is used by the top-level Supervisor object to shut down the supervisor API while the shutdown is in progress.

## How the target state is applied

Whenever there's a change in the target state, this change is stored by calling `deviceState.setTarget`. This is called by the APIBinder when it gets a new state object from the balena API.

Once there's a target state to apply, `triggerApplyTarget` will be used to actually start applying it.
This function uses some flags (`applyInProgress`, `scheduledApply`, etc) to avoid triggering the application more than once in parallel - subsequent calls to triggerApplyTarget will just ensure that, once the current run completes, the engine will apply the target state once more - this is particularly important to allow forcing the update lock if the request to force it comes while we're already applying the target state. There's also delays in place to allow having an exponential backoff when applying the target state fails repeatedly.

The actual function that applies the target state is `applyTarget`. This is where the most central functions of the supervisor are implemented. The behavior of this function is as follows:

1) We get the current state of the device. This uses both DeviceConfig and ApplicationManager to directly query the host OS and balenaEngine for what configuration values are set, what images are available, what containers are running, etc. This is done so that we don't duplicate the current state with entries in the database, which would make some of the supervisor's actions non-atomic (for instance, if we stored information about running containers in the db, and the device powers off between starting the container and storing the information, in the next boot there'll be information missing). This is why all metadata about containers is stored in container labels or the container's name (since this is the only mutable field that docker gives us).
2) We get the target state from the DB, and format it taking into account some aspects of the device's current state (e.g. IP addresses and existing container IDs might affect other container's environment variables or configuration)
3) We ask the DeviceConfig what immediate next steps / actions are required to make the device configuration match the target state. This goes before applications because we assume configuration of the OS and supervisor are a prerequisite for applications to run properly. If there's actions to run, we run them.
4) If there's no configuration actions, we ask the ApplicationManager what the next steps are, and we run them.
5) If we've run any actions in this cycle, we go back to step 1 and run this again, until there's no more actions / steps to apply.

This iterative approach, where we get current and target state, apply the next steps, then get the state again, serves several purposes: on the one hand, it simplifies the logic in the underlying models (ApplicationManager and DeviceConfig) so that they only need to output a single action for each element of the state. E.g. if there's a running container that needs to be killed, we always kill it, no matter what came before or what may come later in the update process. On the other hand, this iterative process allows some level of error recovery and even fixing some instances of filesystem corruption - since we always compare every aspect of running containers with the target, anything that is not matching the target state will be iteratively fixed. If we start a container and for some reason its configuration doesn't match the target (we've actually seen docker bugs cause things like this), the next cycle will kill that container and try again. This is by no means complete or perfect, and there's potential to improve it by adding some attention to history when determining the next steps: e.g. if we've started the same container several times without success, attempt a recovery by restarting balenaEngine or performing some other runtime fix.

It's worth noting that some supervisor API actions, for instance application restarts, will pause the current applyTarget run and start a new instance of applyTarget in parallel, using the `intermediate` flag. In the application restart example, we apply an intermediate target state where there's no containers running (which effectively stops the application), and then apply another intermediate state that equals the state before the restart action started (which restarts all containers respecting dependencies), and finally we trigger the regular state application once more (to recover in case the restart action came in while we were already applying an update).
