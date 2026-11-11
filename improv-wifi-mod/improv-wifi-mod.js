import BLEServer from "bleserver";
import GAP from 'gap';
import { uuid } from "btutils";
import BLEExports from './consts';
import { PacketBuffer, parseWifiSettings, buildRpcResult, isValidPacket } from './packet';

const StateCodes = BLEExports.StateCodes;
const ErrorCodes = BLEExports.ErrorCodes;
const Commands = BLEExports.Commands;

// FYI class definition for BLEServer can be found @ <moddable-project-dir>/modules/network/ble/bleserver.js
export default class ImprovWifi extends BLEServer {
    deviceName;
    state;
    error;
    stateCharacteristic;
    errorCharacteristic;
    rpcCharacteristic;
    onCredentialsRecieved;
    onIdentify;
    redirectUrl;
    rpcResultValue;
    packetBuffer;

    constructor({ deviceName, onCredentialsRecieved, onIdentify, redirectUrl = "" }) {
        super();
        this.deviceName = deviceName;
        this.state = StateCodes.STATE_AUTHORIZED;
        this.error = ErrorCodes.ERROR_NONE;
        this.onCredentialsRecieved = onCredentialsRecieved;
        this.onIdentify = onIdentify;
        this.redirectUrl = redirectUrl;
        this.rpcResultValue = null;
        this.packetBuffer = new PacketBuffer();
    }

    startImprov() {
        if (typeof trace !== "undefined") trace("Starting Improv\n");
        let advertisingData = {
            flags: GAP.ADFlag.LE_GENERAL_DISCOVERABLE_MODE,
            completeUUID128List: [uuid `00467768-6228-2272-4663-277478268000`],
            completeName: this.deviceName,
            shortName: this.deviceName,
        };
        this.startAdvertising({ advertisingData });
    }

    onDisconnected() {
        if (typeof trace !== "undefined") trace("Disconnected\n");
        this.state = StateCodes.STATE_AUTHORIZED;
        this.error = ErrorCodes.ERROR_NONE;
        this.errorCharacteristic = null;
        this.stateCharacteristic = null;
        this.rpcCharacteristic = null;
        this.rpcResultValue = null;
        this.packetBuffer.reset();
        this.startImprov();
    }

    onReady() {
        if (typeof trace !== "undefined") trace("Ready\n");
        this.startImprov();
    }

    onCharacteristicRead(characteristic) {
        if (typeof trace !== "undefined") trace(`Read: ${JSON.stringify(characteristic)}\n`);
        switch (characteristic.name) {
            case "ERROR":
                return this.error;
            case "STATE":
                return this.state;
            case "RPC_RESULT":
                return this.rpcResultValue !== null ? this.rpcResultValue : this.state;
            case "CAPABILITIES":
                // Bit 0 = identify supported (1 if onIdentify callback is provided, else 1 default)
                return 0x01;
            default:
                if (typeof trace !== "undefined") trace(`I have no idea what ${characteristic.name} is supposed to be\n`);
                return this.error;
        }
    }

    onConnected() {
        if (typeof trace !== "undefined") trace("Connected\n");
        this.state = StateCodes.STATE_AUTHORIZED;
        this.error = ErrorCodes.ERROR_NONE;
        this.rpcResultValue = null;
        this.packetBuffer.reset();
    }

    onCharacteristicNotifyDisabled(characteristic) {
        if (typeof trace !== "undefined") trace('onCharacteristicNotifyDisabled\n');
        switch (characteristic.name) {
            case 'STATE':
                this.stateCharacteristic = null;
                break;
            case 'ERROR':
                this.errorCharacteristic = null;
                break;
            case 'RPC_RESULT':
                this.rpcCharacteristic = null;
                break;
            case 'CAPABILITIES':
                break;
            default:
                this.error = ErrorCodes.ERROR_UNKNOWN;
                this.notifyError();
                break;
        }
    }

    onCharacteristicNotifyEnabled(characteristic) {
        if (typeof trace !== "undefined") trace(`onCharacteristicNotifyEnabled: characteristic: ${characteristic.name} \n`);
        switch (characteristic.name) {
            case 'STATE':
                this.stateCharacteristic = characteristic;
                this.notifyState();
                break;
            case 'ERROR':
                this.errorCharacteristic = characteristic;
                this.notifyError();
                break;
            case 'RPC_COMMAND':
                break;
            case 'RPC_RESULT':
                this.rpcCharacteristic = characteristic;
                if (this.rpcResultValue) {
                    this.notifyRpcResult();
                }
                break;
            case 'CAPABILITIES':
                this.notifyValue(characteristic, 0x01);
                break;
            default:
                this.error = ErrorCodes.ERROR_UNKNOWN;
                this.notifyError();
                break;
        }
    }

    onCharacteristicWritten(characteristic, value) {
        if (typeof trace !== "undefined") {
            trace(`Written: ${characteristic.name}, in state ${this.state}, with value ${value}\n`);
        }
        switch (characteristic.name) {
            case "RPC_COMMAND":
                this.handleRpcCommandChunk(value);
                break;
            default:
                this.error = ErrorCodes.ERROR_UNKNOWN;
                this.notifyError();
                break;
        }
    }

    handleRpcCommandChunk(chunk) {
        const feedResult = this.packetBuffer.feed(chunk);
        if (feedResult === 'INCOMPLETE') {
            if (typeof trace !== "undefined") trace("Buffering partial RPC packet chunk\n");
            return;
        }

        if (feedResult === 'INVALID') {
            if (typeof trace !== "undefined") trace("Invalid RPC packet or checksum error\n");
            this.packetBuffer.reset();
            this.error = ErrorCodes.ERROR_INVALID_RPC;
            this.notifyError();
            return;
        }

        const fullPacket = this.packetBuffer.getPacket();
        this.packetBuffer.reset();
        this.dispatchRpcCommand(fullPacket);
    }

    dispatchRpcCommand(packet) {
        const command = packet[0];
        switch (command) {
            case Commands.WIFI_SETTINGS:
                if (this.state !== StateCodes.STATE_AUTHORIZED) {
                    if (typeof trace !== "undefined") trace("Received wifi settings while not in authorized state\n");
                    this.error = ErrorCodes.ERROR_NOT_AUTHORIZED;
                    this.notifyError();
                    return;
                }
                this.state = StateCodes.STATE_PROVISIONING;
                this.notifyState();
                this.handleWifiSettingsPacket(packet);
                break;

            case Commands.IDENTIFY:
                this.handleIdentifyPacket(packet);
                break;

            default:
                if (typeof trace !== "undefined") trace(`Unknown RPC command: ${command}\n`);
                this.error = ErrorCodes.ERROR_UNKNOWN_RPC;
                this.notifyError();
                break;
        }
    }

    handleIdentifyPacket(packet) {
        if (!isValidPacket(packet)) {
            this.error = ErrorCodes.ERROR_INVALID_RPC;
            this.notifyError();
            return;
        }
        if (typeof trace !== "undefined") trace("Handling identify command\n");
        if (typeof this.onIdentify === "function") {
            try {
                this.onIdentify();
            } catch (e) {
                if (typeof trace !== "undefined") trace(`onIdentify error: ${e}\n`);
            }
        }
    }

    handleWifiSettingsPacket(packet) {
        if (typeof trace !== "undefined") trace("Handling wifi settings packet\n");
        const creds = parseWifiSettings(packet);
        if (!creds) {
            if (typeof trace !== "undefined") trace("Failed to parse wifi settings payload\n");
            this.state = StateCodes.STATE_AUTHORIZED;
            this.error = ErrorCodes.ERROR_INVALID_RPC;
            this.notifyState();
            this.notifyError();
            return;
        }

        let result = false;
        try {
            result = this.onCredentialsRecieved(creds);
        } catch (e) {
            if (typeof trace !== "undefined") trace(`onCredentialsRecieved threw error: ${e}\n`);
            result = false;
        }

        if (!result) {
            if (typeof trace !== "undefined") trace("Credentials were not accepted or connection failed\n");
            this.state = StateCodes.STATE_AUTHORIZED;
            this.error = ErrorCodes.ERROR_UNABLE_TO_CONNECT;
            this.notifyState();
            this.notifyError();
            return;
        }

        if (typeof trace !== "undefined") trace("Credentials authorized and provisioned successfully\n");
        this.error = ErrorCodes.ERROR_NONE;
        this.state = StateCodes.STATE_PROVISIONED;
        this.notifyState();

        const urlList = this.redirectUrl ? [this.redirectUrl] : [];
        this.rpcResultValue = buildRpcResult(Commands.WIFI_SETTINGS, urlList);
        this.notifyRpcResult();
    }

    notifyState() {
        if (typeof trace !== "undefined") trace(`Notifying state: ${this.state}\n`);
        if (!this.stateCharacteristic) return;
        this.notifyValue(this.stateCharacteristic, this.state);
    }

    notifyError() {
        if (typeof trace !== "undefined") trace(`Notifying error: ${this.error}\n`);
        if (!this.errorCharacteristic) return;
        this.notifyValue(this.errorCharacteristic, this.error);
    }

    notifyRpcResult() {
        if (typeof trace !== "undefined") trace(`Notifying RPC Result: ${this.rpcResultValue}\n`);
        if (!this.rpcCharacteristic || !this.rpcResultValue) return;
        this.notifyValue(this.rpcCharacteristic, this.rpcResultValue);
    }

    couldNotConnect() {
        if (typeof trace !== "undefined") trace("Could not connect\n");
        this.error = ErrorCodes.ERROR_UNABLE_TO_CONNECT;
        this.notifyError();
    }
}
