// Homebridge plugin for Home Connect home appliances
// Copyright © 2019-2023 Alexander Thoukydides

import { EventEmitter } from 'events';
import { APIStatusCodeError } from './api-errors';
import { logError } from './utils';

// Minimum event stream interruption before treated as appliance disconnected
const EVENT_DISCONNECT_DELAY = 3;           // (seconds)

// Delay before retrying a failed read of appliance state when connected
const CONNECTED_RETRY_MIN_DELAY = 5;        // (seconds)
const CONNECTED_RETRY_MAX_DELAY = 10 * 60;  // (seconds)
const CONNECTED_RETRY_FACTOR = 2;           // (double delay on each retry)

// Blackout period for workaround implicitly setting power state
const POWERSTATE_BLACKOUT = 2;              // (seconds)

const MS = 1000;

// Low-level access to the Home Connect API
export class HomeConnectDevice extends EventEmitter {

    // Create a new API object
    constructor(log, api, ha) {
        super();
        this.log = log;
        this.api = api;
        Object.assign(this, ha);

        // Initial device state
        this.items = {};
        this.setConnectedState(this.connected);

        // Disable warning for more than 10 listeners on an event
        this.setMaxListeners(0);

        // Workaround appliances not reliably indicating power state
        this.inferPowerState();

        // Start streaming events
        this.processEvents();
    }

    // Stop event stream (and any other autonomous activity)
    stop() {
        this.stopEvents = true;
    }

    // Describe an item
    describe(item) {
        let description = item.key;
        if ('value' in item) {
            description += '=' + item.value;
        } else if ('default' in (item.constraints || {})) {
            description += '=' + item.constraints.default;
        }
        if (item.unit && item.unit !== 'enum') {
            description += ' ' + item.unit;
        }
        return description;
    }

    // Update cached values and notify listeners
    update(items) {
        // Update cached state for all items before notifying any listeners
        items.forEach(item => {
            this.items[item.key] = item.value;
        });

        // Notify listeners for each item
        items.forEach(item => {
            let description = this.describe(item);
            this.log.debug(`${description} (${this.listenerCount(item.key)} listeners)`);
            try {
                this.emit(item.key, item.value);
            } catch (err) {
                logError(this.log, `Update emit ${description}`, err);
            }
        });
    }

    // Get a cached item's value
    getItem(key) {
        return this.items[key];
    }

    // Read details about this appliance (especially its connection status)
    async getAppliance() {
        try {
            this.requireIdentify();
            let appliance = await this.api.getAppliance(this.haId);
            if (appliance === undefined) throw new Error('Empty response');
            this.setConnectedState(appliance.connected);
            return appliance;
        } catch (err) {
            throw logError(this.log, 'GET appliance', err);
        }
    }

    // Read current status
    async getStatus() {
        try {
            this.requireMonitor();
            let status = await this.api.getStatus(this.haId);
            if (status === undefined) throw new Error('Empty response');
            this.update(status);
            return status;
        } catch (err) {
            throw logError(this.log, 'GET status', err);
        }
    }

    // Read current settings
    async getSettings() {
        try {
            this.requireSettings();
            let settings = await this.api.getSettings(this.haId);
            if (settings === undefined) throw new Error('Empty response');
            this.update(settings);
            return settings;
        } catch (err) {
            throw logError(this.log, 'GET settings', err);
        }
    }

    // Read a single setting
    async getSetting(settingKey) {
        try {
            this.requireSettings();
            let item = await this.api.getSetting(this.haId, settingKey);
            if (item === undefined) throw new Error('Empty response');
            this.update([item]);
            return item;
        } catch (err) {
            if (err instanceof APIStatusCodeError
                && (err.key === 'SDK.Error.UnsupportedSetting'
                 || err.key === 'SDK.Simulator.InternalError')) {
                // Suppress error when the setting is unsupported
                return null;
            }
            throw logError(this.log, `GET ${settingKey}`, err);
        }
    }

    // Write a single setting
    async setSetting(settingKey, value) {
        try {
            this.requireSettings();
            this.requireRemoteControl();
            await this.api.setSetting(this.haId, settingKey, value);
            this.update([{ key: settingKey, value: value }]);
        } catch (err) {
            throw logError(this.log, `SET ${settingKey}=${value}`, err);
        }
    }

    // Read the list of all programs
    async getAllPrograms() {
        try {
            this.requireMonitor();
            let programs = await this.api.getPrograms(this.haId);
            if (programs.active?.key) {
                this.update([{ key: 'BSH.Common.Root.ActiveProgram',
                    value: programs.active.key }]);
                this.update(programs.active.options);
            } else if (programs.selected?.key) {
                this.update([{ key: 'BSH.Common.Root.SelectedProgram',
                    value: programs.selected.key }]);
                this.update(programs.selected.options);
            }
            return programs.programs;
        } catch (err) {
            throw logError(this.log, 'GET programs', err);
        }
    }

    // Read the list of currently available programs
    async getAvailablePrograms() {
        try {
            this.requireMonitor();
            let programs = await this.api.getAvailablePrograms(this.haId);
            if (programs.active?.key) {
                this.update([{ key: 'BSH.Common.Root.ActiveProgram',
                    value: programs.active.key }]);
                this.update(programs.active.options);
            } else if (programs.selected?.key) {
                this.update([{ key: 'BSH.Common.Root.SelectedProgram',
                    value: programs.selected.key }]);
                this.update(programs.selected.options);
            }
            return programs.programs;
        } catch (err) {
            if (err instanceof APIStatusCodeError
                && err.key === 'SDK.Error.WrongOperationState') {
                // Suppress error when there are no available programs
                return [];
            }
            throw logError(this.log, 'GET available programs', err);
        }
    }

    // Read the options for a currently available program
    async getAvailableProgram(programKey) {
        try {
            this.requireMonitor();
            let program = await this.api.getAvailableProgram(this.haId,
                                                             programKey);
            if (program === undefined) throw new Error('Empty response');
            return program;
        } catch (err) {
            throw logError(this.log, `GET available program ${programKey}`, err);
        }
    }

    // Read the currently selected program
    async getSelectedProgram() {
        try {
            this.requireMonitor();
            let program = await this.api.getSelectedProgram(this.haId);
            if (program === undefined) throw new Error('Empty response');
            this.update([{ key:   'BSH.Common.Root.SelectedProgram',
                value: program.key }]);
            if (this.getItem('BSH.Common.Status.OperationState')
                === 'BSH.Common.EnumType.OperationState.Ready') {
                // Only update options when no program is active
                this.update(program.options);
            }
            return program;
        } catch (err) {
            if (err instanceof APIStatusCodeError
                && err.key === 'SDK.Error.NoProgramSelected') {
                // Suppress error when there is no selected program
                return null;
            }
            throw logError(this.log, 'GET selected program', err);
        }
    }

    // Select a program
    async setSelectedProgram(programKey, options = {}) {
        try {
            this.requireControl();
            this.requireRemoteControl();
            let programOptions = [];
            for (let key of Object.keys(options)) {
                programOptions.push({
                    key:   key,
                    value: options[key]
                });
            }
            await this.api.setSelectedProgram(this.haId, programKey,
                                              programOptions);
            this.update([{ key:   'BSH.Common.Root.SelectedProgram',
                value: programKey }]);
            this.update(programOptions);
        } catch (err) {
            throw logError(this.log, `SET selected program ${programKey}`, err);
        }
    }

    // Read the currently active program (if any)
    async getActiveProgram() {
        try {
            // Only request the active program if one might be active
            let inactiveStates = [
                'BSH.Common.EnumType.OperationState.Inactive',
                'BSH.Common.EnumType.OperationState.Ready'
            ];
            let operationState =
                this.getItem('BSH.Common.Status.OperationState');
            if (!inactiveStates.includes(operationState)) {
                this.requireMonitor();
                let program = await this.api.getActiveProgram(this.haId);
                if (program === undefined) throw new Error('Empty response');
                this.update([{ key:   'BSH.Common.Root.ActiveProgram',
                    value: program.key }]);
                this.update(program.options);
                return program;
            } else {
                this.log.debug(`Ignoring GET active program in ${operationState}`);
                return null;
            }
        } catch (err) {
            if (err instanceof APIStatusCodeError
                && err.key === 'SDK.Error.NoProgramActive') {
                // Suppress error when there is no active program
                return null;
            }
            throw logError(this.log, 'GET active program', err);
        }
    }

    // Start a program
    async startProgram(programKey, options = {}) {
        try {
            this.requireControl();
            this.requireRemoteStart();
            if (!programKey)
                programKey = this.getItem('BSH.Common.Root.SelectedProgram');
            let programOptions = [];
            for (let key of Object.keys(options)) {
                programOptions.push({
                    key:   key,
                    value: options[key]
                });
            }
            await this.api.setActiveProgram(this.haId, programKey,
                                            programOptions);
            this.update([{ key:   'BSH.Common.Root.ActiveProgram',
                value: programKey }]);
            this.update(programOptions);
        } catch (err) {
            throw logError(this.log, `START active program ${programKey}`, err);
        }
    }

    // Stop a program
    async stopProgram() {
        try {
            // No action required unless a program is active
            let activeStates = [
                'BSH.Common.EnumType.OperationState.DelayedStart',
                'BSH.Common.EnumType.OperationState.Run',
                'BSH.Common.EnumType.OperationState.Pause',
                'BSH.Common.EnumType.OperationState.ActionRequired'
            ];
            let operationState =
                this.getItem('BSH.Common.Status.OperationState');
            if (activeStates.includes(operationState)) {
                this.requireControl();
                this.requireRemoteControl();
                await this.api.stopActiveProgram(this.haId);
            } else {
                this.log.debug(`Ignoring STOP active program in ${operationState}`);
            }
        } catch (err) {
            throw logError(this.log, 'STOP active program', err);
        }
    }

    // Get a list of supported commands
    async getCommands() {
        try {
            this.requireControl();
            let commands = await this.api.getCommands(this.haId);
            if (commands === undefined) throw new Error('Empty response');
            return commands;
        } catch (err) {
            if (err instanceof APIStatusCodeError && err.key === '404') {
                // Suppress error when the API is not supported
                return [];
            }
            throw logError(this.log, 'GET commands', err);
        }
    }

    // Pause or resume program
    async pauseProgram(pause = true) {
        let command = pause ? 'BSH.Common.Command.PauseProgram'
                            : 'BSH.Common.Command.ResumeProgram';
        try {
            this.requireControl();
            this.requireRemoteControl();
            return await this.api.setCommand(this.haId, command);
        } catch (err) {
            throw logError(this.log, `COMMAND ${command}`, err);
        }
    }

    // Open or partly open door
    async openDoor(fully = true) {
        let command = fully ? 'BSH.Common.Command.OpenDoor'
                            : 'BSH.Common.Command.PartlyOpenDoor';
        try {
            this.requireControl();
            return await this.api.setCommand(this.haId, command);
        } catch (err) {
            throw logError(this.log, `COMMAND ${command}`, err);
        }
    }

    // Set a specific option of the active program
    async setActiveProgramOption(optionKey, value) {
        try {
            this.requireControl();
            this.requireRemoteControl();
            await this.api.setActiveProgramOption(this.haId, optionKey, value);
            this.update([{ key: optionKey, value: value }]);
        } catch (err) {
            throw logError(this.log, `SET ${optionKey}=${value}`, err);
        }
    }

    // Wait for the appliance to be connected
    waitConnected(immediate = false) {
        // Check whether the appliance is already connected
        if (immediate && this.getItem('connected'))
            return Promise.resolve();

        // Otherwise wait
        return new Promise(resolve => {
            // Listen for updates to the operation state
            let listener = connected => {
                if (connected) {
                    this.off('connected', listener);
                    resolve();
                }
            };
            this.on('connected', listener);
        });
    }

    // Wait for the appliance to enter specific states
    waitOperationState(states, milliseconds) {
        // Check whether the appliance is already in the target state
        if (states.includes(this.getItem('BSH.Common.Status.OperationState')))
            return Promise.resolve();

        // Otherwise wait
        let listener;
        return new Promise((resolve, reject) => {
            // Listen for updates to the operation state
            this.on('BSH.Common.Status.OperationState', operationState => {
                if (states.includes(operationState)) resolve();
            });

            // Wait for the specified timeout, if any
            if (milliseconds !== undefined)
                setTimeout(() => {
                    reject(new Error('Timeout waiting for OperationState'));
                }, milliseconds);
        }).finally(() => {
            // Remove the update listener
            this.off('BSH.Common.Status.OperationState', listener);
        });
    }

    // Workaround appliances not reliably indicating power state
    inferPowerState() {
        // Disable workaround for blackout period after power status updated
        let blackoutScheduled;
        this.on('BSH.Common.Setting.PowerState', () => {
            clearTimeout(blackoutScheduled);
            blackoutScheduled = setTimeout(() => {
                blackoutScheduled = undefined;
            }, POWERSTATE_BLACKOUT * MS);
        });

        //
        this.on('BSH.Common.Status.OperationState', operationState => {
            // Map operation state to power
            let operationPowerMap = {
                'BSH.Common.EnumType.OperationState.Inactive': false,
                'BSH.Common.EnumType.OperationState.Ready':    true,
                'BSH.Common.EnumType.OperationState.Run':      true
            };
            if (!(operationState in operationPowerMap)) return;
            let operationImpliesOn = operationPowerMap[operationState];

            // Map power to operation state
            let powerState = this.getItem('BSH.Common.Setting.PowerState');
            let stateIsOn = powerState === 'BSH.Common.EnumType.PowerState.On';

            // Fake the power state if there is a mismatch
            if (operationImpliesOn && !stateIsOn) {
                if (blackoutScheduled) {
                    this.log.debug('Operation state implies power is on (ignored)');
                } else {
                    this.log.debug('Operation state implies power is on');
                    this.update([{ key: 'BSH.Common.Setting.PowerState',
                        value: 'BSH.Common.EnumType.PowerState.On' }]);
                }
            } else if (!operationImpliesOn && stateIsOn) {
                this.log.debug('Operation state implies power is standby or off');
                this.update([{ key: 'BSH.Common.Setting.PowerState',
                    value: 'BSH.Common.EnumType.PowerState.Standby' }]);
            }
        });
    }

    // Update whether the appliance is currently reachable
    setConnectedState(isConnected) {
        // Update the internal state immediately (if known)
        if (isConnected !== undefined) this.connected = isConnected;
        if (isConnected === false) this.onDisconnected();

        // Only apply the most recent of multiple updates
        clearTimeout(this.setConnectedScheduled);
        this.setConnectedScheduled = setTimeout(() => {
            // Inform clients immediately when disconnected
            if (!this.connected && this.getItem('connected') !== false) {
                this.update([{ key: 'connected', value: false }]);
            }

            // Read information from this appliance when it connects
            if (isConnected !== false) this.onConnected();
        });
    }

    // Refresh appliance information when it reconnects (or connection unknown)
    onConnected() {
        // No action required if already reading (or read) appliance state
        if (this.readAllActions) return;

        // Construct a list of pending appliance state to read
        this.readAllActions = [
            () => this.getAppliance(), // (checks connected and resets error)
            () => this.getStatus(),
            () => this.getSettings()
        ];
        if (this.hasPrograms) this.readAllActions.push(
            () => this.getSelectedProgram(),
            () => this.getActiveProgram()
        );

        // Schedule the pending reads
        if (!this.readAllScheduled) {
            this.log.debug((this.connected ? 'Connected' : 'Might be connected')
                           + ', so reading appliance state...');
            this.readAllScheduled = setTimeout(() => this.readAll());
        } else {
            this.log.debug('Connected, but appliance state read already pending...');
        }
    }

    // Abort refreshing appliance information when it disconnects
    onDisconnected() {
        if (this.readAllActions && this.readAllActions.length) {
            this.log.debug(`Appliance disconnected; abandoning ${this.readAllActions.length} pending reads`);
        }
        delete this.readAllActions;
    }

    // Attempt to read all appliance state when connected
    async readAll() {
        try {
            // Attempt all pending reads
            while (this.readAllActions && this.readAllActions.length) {
                // Careful to avoid losing action if error or array replaced
                let actions = this.readAllActions;
                await actions[0]();
                actions.shift();
            }

            // Either abandoned or finished all pending reads
            delete this.readAllScheduled;
            if (this.readAllActions) {
                // Successfully read all appliance state
                this.log.debug('Successfully read all appliance state');
                delete this.api.readAllRetryDelay;
                if (this.connected && !this.getItem('connected')) {
                    this.update([{ key: 'connected', value: true }]);
                }
            } else {
                // Abandoned reading appliance state due to disconnection
                this.log.debug('Ignoring appliance state read due to disconnection');
            }
        } catch (err) {
            // Attempt to recover after an error
            if (this.connected) {
                logError(this.log, 'Reading appliance state (will retry)', err);
                this.api.readAllRetryDelay =
                    this.api.readAllRetryDelay
                    ? Math.min(this.api.readAllRetryDelay
                               * CONNECTED_RETRY_FACTOR,
                               CONNECTED_RETRY_MAX_DELAY)
                    : CONNECTED_RETRY_MIN_DELAY;
                this.log.debug('Still connected, so retrying appliance state'
                             + ` read in ${this.api.readAllRetryDelay} seconds...`);
                this.readAllScheduled =
                    setTimeout(() => this.readAll(),
                               this.api.readAllRetryDelay * MS);
            } else {
                this.log.debug(`Ignoring appliance state read due to disconnection: ${err.message}`);
                delete this.readAllScheduled;
            }
        }
    }

    // Ensure that the appliance is connected
    requireConnected() {
        if (!this.connected)
            throw new Error('The appliance is offline');
    }

    // Ensure that IdentifyAppliance scope has been authorised
    requireIdentify() {
        if (!this.api.hasScope('IdentifyAppliance'))
            throw new Error('IdentifyAppliance scope has not been authorised');
    }

    // Ensure that Monitor scope has been authorised
    requireMonitor() {
        if (!this.hasScope('Monitor'))
            throw new Error('Monitor scope has not been authorised');
        this.requireConnected();
    }

    // Ensure that Settings scope has been authorised
    requireSettings() {
        if (!this.hasScope('Settings'))
            throw new Error('Settings scope has not been authorised');
        this.requireConnected();
    }

    // Ensure that Control scope has been authorised
    requireControl() {
        if (!this.hasScope('Control'))
            throw new Error('Control scope has not been authorised');
        this.requireConnected();
    }

    // Ensure that remote control is currently allowed
    requireRemoteControl() {
        if (this.getItem('BSH.Common.Status.LocalControlActive'))
            throw new Error('Appliance is being manually controlled locally');
        if (this.getItem('BSH.Common.Status.RemoteControlActive') === false)
            throw new Error('Remote control not enabled on the appliance');
    }

    // Ensure that remote start is currently allowed
    requireRemoteStart() {
        this.requireRemoteControl();
        if (this.getItem('BSH.Common.Status.RemoteControlStartAllowed')
            === false)
            throw new Error('Remote start not enabled on the appliance');
    }

    // Check whether a particular scope has been authorised
    hasScope(scope) {
        return this.api.hasScope(scope)
            || this.api.hasScope(this.type + '-' + scope);
    }

    // Enable polling of selected/active programs when connected
    pollPrograms(enable = true) {
        this.hasPrograms = enable;
    }

    // Process received events
    async processEvents() {
        try {
            for await (const event of this.api.getEvents(this.haId)) {
                this.eventListener(event);
                if (this.stopEvents) break;
            }
        } catch (err) {
            logError(this.log, 'Device events', err);
        }
    }

    eventListener(event) {
        let itemCount = event.data?.items?.length || 0;
        this.log.debug(`Event ${event.event} (${itemCount} items)`);
        switch (event.event) {
        case 'START':
            // If appliance disconnected then check its current status
            clearTimeout(this.stopScheduled);
            this.setConnectedState();
            break;
        case 'STOP':
            // Disconnect appliance if too slow re-establishing event stream
            this.stopScheduled = setTimeout(() => {
                this.log.debug('Events may have been missed;'
                             + ' treating appliance as disconnected');
                this.setConnectedState(false);
            }, event.err ? 0 : EVENT_DISCONNECT_DELAY * MS);
            break;
        case 'PAIRED':
            // Check status if an appliance is added back to the account
            this.log.debug('Appliance restored to Home Connect account');
            this.setConnectedState();
            break;
        case 'DEPAIRED':
            // Immediately treat a removed appliance as disconnected
            this.log.debug('Appliance removed from Home Connect account;'
                         + ' treating appliance as disconnected');
            this.setConnectedState(false);
            break;
        case 'CONNECTED':
            this.log.debug('Appliance is now connected to Home Connect servers');
            this.setConnectedState(true);
            break;
        case 'DISCONNECTED':
            this.log.debug('Appliance lost connection to Home Connect servers');
            this.setConnectedState(false);
            break;
        case 'STATUS':
        case 'EVENT':
        case 'NOTIFY':
            this.update(event.data.items);
            break;
        default:
            logError(this.log, 'Event stream', new Error(`Unsupported type: ${event.event}`));
            break;
        }
    }

    // Query the currently selected API language
    getLanguage() {
        return this.api.language;
    }
}
