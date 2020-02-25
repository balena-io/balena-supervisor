# Supervisor model

The Supervisor class implements all the functionality in the balena Supervisor. It contains several sub-models to perform all of the features that the supervisor needs to have.

# Components

The supervisor is composed by the following sub-models:

* db (Database): an sqlite3 database using knex.js
* config (Config): a configuration object that uses config.json and the db as storage backends
* eventTracker (EventTracker): used to send events to Mixpanel
* logger (Logger): sends supervisor and application logs to the balena API
* deviceState (DeviceState): the device state engine, manages the state of device configuration and applications
* apiBinder (APIBinder): binds the device to a remote API, i.e. the balena API, getting a target state and reporting the current state
* api (SupervisorAPI): exposes the supervisor's [API](../API.md)

## Construction and initialization

The general approach taken in the Supervisor and its sub-models is to separate construction and initialization. In general, constructors create any objects that are needed by an instance, as well as any attributes or internal variables. Initialization functions (usually called `init`) implement the actual behavior of the instance, running any startup procedures and starting the long-running processes/intervals that execute actions or change state.

The initialization order has a reason to be defined as it is:

1) db, config and eventTracker are initialized as most of the other models use them
2) The apiBinder's API client is initialized (`apiBinder.initClient`) since the deviceState might need to access the API when normalising state if updating from a legacy OS
3) The logger is initialized so that we can start sending log messages for the next actions
4) When updating from an older OS (before multicontainer support), we normalise the state by deleting any running containers, getting the target state from the API, and backfilling fields that may be missing like serviceIds and imageIds.
5) The deviceState is initialized, which starts applying the target state
6) The supervisor API is started now that deviceState is ready to receive requests
7) Finally, we initialize the apiBinder, which needs the deviceState ready to apply the target state. This will provision the device on the API if it's not there yet, report the initial configuration, and start the loops to update the target state and report the current one.
