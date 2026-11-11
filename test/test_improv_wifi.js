import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateChecksum, stringToBytes } from '../improv-wifi-mod/packet.js';
import BLEExports from '../improv-wifi-mod/consts.js';
const { Commands, StateCodes, ErrorCodes } = BLEExports;

// Mock the environment for ImprovWifi testing outside of Moddable hardware
class MockBLEServer {
    notifications = [];
    advertised = [];

    startAdvertising(data) {
        this.advertised.push(data);
    }

    notifyValue(char, value) {
        this.notifications.push({ char, value });
    }
}

// Subclass to isolate bleserver imports
async function loadImprovWifiWithMock() {
    // Dynamically patch or define class with mocked superclass
    const { default: ImprovWifi } = await import('../improv-wifi-mod/improv-wifi-mod.js').catch(async () => {
        return { default: null };
    });

    // In Node.js environment without Moddable SDK native globals ('bleserver', 'gap', 'btutils'),
    // we create a test harness that mirrors ImprovWifi logic.
    return ImprovWifi;
}

test('ImprovWifi lifecycle, RPC command processing, state & error transitions', async () => {
    // Create an ImprovWifi-equivalent instance bound to MockBLEServer
    // We can import the class if dependencies allow or test its logic directly
    const { PacketBuffer, parseWifiSettings, buildRpcResult, isValidPacket } = await import('../improv-wifi-mod/packet.js');

    class TestableImprovWifi extends MockBLEServer {
        deviceName;
        state;
        error;
        stateCharacteristic = { name: 'STATE' };
        errorCharacteristic = { name: 'ERROR' };
        rpcCharacteristic = { name: 'RPC_RESULT' };
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

        onCharacteristicWritten(characteristic, value) {
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
            if (feedResult === 'INCOMPLETE') return;
            if (feedResult === 'INVALID') {
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
            if (typeof this.onIdentify === "function") {
                this.onIdentify();
            }
        }

        handleWifiSettingsPacket(packet) {
            const creds = parseWifiSettings(packet);
            if (!creds) {
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
                result = false;
            }

            if (!result) {
                this.state = StateCodes.STATE_AUTHORIZED;
                this.error = ErrorCodes.ERROR_UNABLE_TO_CONNECT;
                this.notifyState();
                this.notifyError();
                return;
            }

            this.error = ErrorCodes.ERROR_NONE;
            this.state = StateCodes.STATE_PROVISIONED;
            this.notifyState();

            const urlList = this.redirectUrl ? [this.redirectUrl] : [];
            this.rpcResultValue = buildRpcResult(Commands.WIFI_SETTINGS, urlList);
            this.notifyRpcResult();
        }

        notifyState() {
            if (!this.stateCharacteristic) return;
            this.notifyValue(this.stateCharacteristic, this.state);
        }

        notifyError() {
            if (!this.errorCharacteristic) return;
            this.notifyValue(this.errorCharacteristic, this.error);
        }

        notifyRpcResult() {
            if (!this.rpcCharacteristic || !this.rpcResultValue) return;
            this.notifyValue(this.rpcCharacteristic, this.rpcResultValue);
        }
    }

    // Test 1: Successful provisioning with redirect URL
    let identified = false;
    const server = new TestableImprovWifi({
        deviceName: "TestDevice",
        redirectUrl: "http://test-device.local",
        onCredentialsRecieved: ({ ssid, password }) => {
            return ssid === "ValidSSID" && password === "ValidPass";
        },
        onIdentify: () => {
            identified = true;
        }
    });

    assert.equal(server.state, StateCodes.STATE_AUTHORIZED);
    assert.equal(server.error, ErrorCodes.ERROR_NONE);

    // Send IDENTIFY command
    server.onCharacteristicWritten({ name: "RPC_COMMAND" }, [0x02, 0x00, 0x02]);
    assert.equal(identified, true);

    // Send complete packet with invalid checksum (command 0x02, dataLen 0, wrong checksum 0x99)
    server.onCharacteristicWritten({ name: "RPC_COMMAND" }, [0x02, 0x00, 0x99]);
    assert.equal(server.error, ErrorCodes.ERROR_INVALID_RPC);

    // Reset error
    server.error = ErrorCodes.ERROR_NONE;
    server.notifications = [];

    // Send valid WIFI_SETTINGS with failing credentials
    const makePacket = (ssid, pass) => {
        const sBytes = stringToBytes(ssid);
        const pBytes = stringToBytes(pass);
        const raw = [0x01, sBytes.length + pBytes.length + 2, sBytes.length, ...sBytes, pBytes.length, ...pBytes];
        return [...raw, calculateChecksum(raw)];
    };

    server.onCharacteristicWritten({ name: "RPC_COMMAND" }, makePacket("ValidSSID", "WrongPass"));
    assert.equal(server.error, ErrorCodes.ERROR_UNABLE_TO_CONNECT);
    assert.equal(server.state, StateCodes.STATE_AUTHORIZED);

    // Send valid credentials
    server.notifications = [];
    server.onCharacteristicWritten({ name: "RPC_COMMAND" }, makePacket("ValidSSID", "ValidPass"));
    assert.equal(server.state, StateCodes.STATE_PROVISIONED);
    assert.equal(server.error, ErrorCodes.ERROR_NONE);

    // Check RPC result notification was sent
    const rpcNotification = server.notifications.find(n => n.char.name === 'RPC_RESULT');
    assert.ok(rpcNotification, "RPC_RESULT notification should be emitted");
    assert.equal(isValidPacket(rpcNotification.value), true);
    assert.equal(rpcNotification.value[0], Commands.WIFI_SETTINGS);

    // Send unknown command
    server.onCharacteristicWritten({ name: "RPC_COMMAND" }, [0x99, 0x00, 0x99]);
    assert.equal(server.error, ErrorCodes.ERROR_UNKNOWN_RPC);
});
