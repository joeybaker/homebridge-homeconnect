// Homebridge plugin for Home Connect home appliances
// Copyright © 2019-2023 Alexander Thoukydides

import { create } from 'node-persist';
import { join } from 'path';
import { satisfies, coerce } from 'semver';
import { setTimeout as setTimeoutP } from 'timers/promises';

import { HomeConnectAPI } from './api';
import { HomeConnectDevice } from './homeconnect-device';
import { ApplianceCleaningRobot, ApplianceDishwasher, ApplianceDryer,
         ApplianceWasher, ApplianceWasherDryer } from './appliance-cleaning';
import { ApplianceCoffeeMaker, ApplianceCookProcessor, ApplianceHob,
         ApplianceHood, ApplianceOven, ApplianceWarmingDrawer } from './appliance-cooking';
import { ApplianceFreezer, ApplianceFridgeFreezer, ApplianceRefrigerator,
         ApplianceWineCooler } from './appliance-cooling';
import { ConfigSchema } from './config_schema';
import { PACKAGE, PLUGIN_NAME, PLUGIN_VERSION, PLATFORM_NAME,
         REQUIRED_HOMEBRIDGE_API } from './settings';
import { PrefixLogger } from './logger';
import { MS } from './utils';

let UUID;

// Required Homebridge API version
const HAP_REQUIRED = '>=0.9.0';

// Interval between updating the list of appliances
// (only 1000 API calls allowed per day, so only check once an hour)
const UPDATE_APPLIANCES_DELAY = 60 * 60 * MS;

// A Homebridge HomeConnect platform
export class HomeConnectPlatform {

    // Create a new HomeConnect platform object
    constructor(log, config, homebridge) {
        log('new HomeConnectPlatform');
        this.log = new PrefixLogger(log);
        this.config = config;
        this.homebridge = homebridge;
        this.accessories = {};

        // Shortcuts to useful HAP objects
        UUID = homebridge.hap.uuid;

        // Check software versions
        log(PLUGIN_NAME + ' version ' + PLUGIN_VERSION);
        this.checkVersion('Node.js', process.versions.node,
                          PACKAGE.engines.node);
        this.checkVersion('Homebridge', homebridge.serverVersion,
                          PACKAGE.engines.homebridge);
        this.checkVersion('Homebridge API', homebridge.version,
                          REQUIRED_HOMEBRIDGE_API);
        this.checkVersion('Homebridge HAP', homebridge.hap.HAPLibraryVersion(),
                          HAP_REQUIRED);

        // Wait for Homebridge to restore cached accessories
        this.homebridge.on('didFinishLaunching',
                           () => this.finishedLaunching());
    }

    // Check and log software versions
    checkVersion(name, current, required) {
        if (satisfies(coerce(current), required)) {
            this.log.info(name + ' version ' + current
                          + ' (satisfies ' + required + ')');
        } else {
            this.log.error(name + ' version ' + current + ' is incompatible'
                           + ' (require ' + required + ')');
        }
    }

    // Restore a cached accessory
    configureAccessory(accessory) {
        accessory.reachable = false;
        this.accessories[accessory.UUID] = accessory;
    }

    // Update list of Home Connect appliances after cache has been restored
    async finishedLaunching() {
        let restored = Object.keys(this.accessories).length;
        if (restored) {
            this.log.info('Restored ' + Object.keys(this.accessories).length
                          + ' cached accessories');
        }

        // Create persistent storage for this plugin
        let persistDir = join(this.homebridge.user.storagePath(),
                              PLUGIN_NAME, 'persist');
        this.persist = create({ dir: persistDir });
        await this.persist.init();

        // Prepare a configuration schema
        this.schema = new ConfigSchema(this.log, this.persist,
                                       this.homebridge.user.storagePath(),
                                       PLUGIN_NAME);

        // Check that essential configuration has been provided
        if (!this.config) {
            if (restored) this.log.info('Plugin configuration missing;'
                                      + ' removing all cached accessories');
            return this.addRemoveAccessories([]);
        }
        if (!this.config['clientid']) {
            this.config['clientid'] = this.config['simulator']
                ? process.env.HOMECONNECT_CLIENT_SIMULATOR
                : process.env.HOMECONNECT_CLIENT_PHYSICAL;
        }
        if (!this.config['clientid']) {
            return this.log.error('Platform ' + PLATFORM_NAME + ' config.json'
                                  + " is missing 'clientid' property");
        }

        // Connect to the Home Connect cloud
        this.homeconnect = new HomeConnectAPI(this.log, this.config, this.persist);
        this.schema.setAuthorised(await this.homeconnect.getAuthorisationURI());

        // Obtain a list of Home Connect home appliances
        this.updateAppliances();
    }

    // Periodically update a list of Home Connect home appliances
    async updateAppliances() {
        for (;;) {
            try {
                let appliances = await this.homeconnect.getAppliances();
                this.log.debug('Found ' + appliances.length + ' appliances');
                await this.addRemoveAccessories(appliances);
            } catch (err) {
                this.log.error('Failed to read list of'
                               + ' home appliances: ' + err);
            }
            await setTimeoutP(UPDATE_APPLIANCES_DELAY);
        }
    }

    // Add or remove accessories to match the available appliances
    async addRemoveAccessories(appliances) {
        // Update the configuration schema
        await this.schema.setAppliances(appliances);

        // Add a Homebridge accessory for each new appliance
        let newAccessories = [];
        for (const ha of appliances) {
            // Select a constructor for this appliance
            let applianceConstructor = {
                // Cooking appliances
                CoffeeMaker:    ApplianceCoffeeMaker,
                CookProcessor:  ApplianceCookProcessor,
                Hob:            ApplianceHob,
                Hood:           ApplianceHood,
                Oven:           ApplianceOven,
                WarmingDrawer:  ApplianceWarmingDrawer,
                // Cleaning appliances
                CleaningRobot:  ApplianceCleaningRobot,
                Dishwasher:     ApplianceDishwasher,
                Dryer:          ApplianceDryer,
                Washer:         ApplianceWasher,
                WasherDryer:    ApplianceWasherDryer,
                // Cooling appliances
                Freezer:        ApplianceFreezer,
                FridgeFreezer:  ApplianceFridgeFreezer,
                Refrigerator:   ApplianceRefrigerator,
                WineCooler:     ApplianceWineCooler
            }[ha.type];
            if (!applianceConstructor)
                return this.log.warn("Appliance type '" + ha.type
                                     + "' not currently supported");

            // Convert the Home Connect haId into a Homebridge UUID
            ha.uuid = UUID.generate(ha.haId);
            let accessory = this.accessories[ha.uuid];
            if (accessory) {
                // An accessory already exists for this appliance
                if (accessory.appliance) return;
                this.log.debug("Connecting accessory '" + ha.name + "'");
            } else {
                // New appliance, so create a matching accessory
                this.log.info("Adding new accessory '" + ha.name + "'");
                accessory = new this.homebridge.platformAccessory(ha.name,
                                                                  ha.uuid);
                this.accessories[ha.uuid] = accessory;
                newAccessories.push(accessory);
            }

            // Construct an instance of the appliance
            const log = new PrefixLogger(this.log, ha.name);
            let device = new HomeConnectDevice(log, this.homeconnect, ha);
            let deviceConfig = this.config[ha.haId] || {};
            try {
                accessory.appliance =
                    new applianceConstructor(
                        log, this.homebridge, this.persist,
                        this.schema.getAppliance(ha.haId),
                        device, accessory, deviceConfig);
            } catch (err) {
                this.log.error('Failed to initialise accessory: ' + err);
            }
        }
        this.homebridge.registerPlatformAccessories(
            PLUGIN_NAME, PLATFORM_NAME, newAccessories);

        // Delete accessories for which there is no matching appliance
        let oldAccessories = [];
        for (const uuid of Object.keys(this.accessories)) {
            let accessory = this.accessories[uuid];
            if (!appliances.some(ha => { return ha.uuid === uuid; })) {
                this.log.info("Removing accessory '"
                            + accessory.displayName + "'");
                if (accessory.appliance) accessory.appliance.unregister();
                oldAccessories.push(accessory);
                delete this.accessories[uuid];
            }
        }
        this.homebridge.unregisterPlatformAccessories(
            PLUGIN_NAME, PLATFORM_NAME, oldAccessories);
    }
}
