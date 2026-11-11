/**
 * Improv Wi-Fi BLE Packet Framing and Utility Functions
 * Follows the Improv Wi-Fi BLE specification: https://www.improv-wifi.com/ble/
 */

/**
 * Calculates simple sum checksum keeping only the LSB (modulo 256).
 * Checksum is calculated over command, data length, and all data bytes.
 * @param {ArrayLike<number>} bytes
 * @param {number} [start=0]
 * @param {number} [end=bytes.length]
 * @returns {number}
 */
export function calculateChecksum(bytes, start = 0, end = bytes.length) {
    let sum = 0;
    for (let i = start; i < end; i++) {
        sum = (sum + bytes[i]) & 0xFF;
    }
    return sum;
}

/**
 * Validates whether an incoming packet has a correct checksum and matches its stated length.
 * Packet structure: [Command, DataLength, Data..., Checksum]
 * Total length should be: 1 (command) + 1 (data length) + DataLength + 1 (checksum) = DataLength + 3
 * @param {ArrayLike<number>} packet
 * @returns {boolean}
 */
export function isValidPacket(packet) {
    if (!packet || packet.length < 3) {
        return false;
    }
    const dataLength = packet[1];
    if (packet.length !== dataLength + 3) {
        return false;
    }
    const expectedChecksum = calculateChecksum(packet, 0, packet.length - 1);
    const actualChecksum = packet[packet.length - 1];
    return expectedChecksum === actualChecksum;
}

/**
 * Parses a UTF-8 string from a byte array.
 * Works across both modern JavaScript / Node.js and Moddable environments.
 * @param {ArrayLike<number>} data
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
export function bytesToString(data, start, end) {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(data.slice ? data.slice(start, end) : Array.prototype.slice.call(data, start, end)).toString('utf-8');
    }
    let str = '';
    for (let i = start; i < end; i++) {
        str += String.fromCharCode(data[i]);
    }
    return decodeURIComponent(escape(str));
}

/**
 * Converts a UTF-8 string to an array of byte values (numbers 0-255).
 * @param {string} str
 * @returns {number[]}
 */
export function stringToBytes(str) {
    if (typeof Buffer !== "undefined") {
        return Array.from(Buffer.from(str, 'utf-8'));
    }
    const utf8Str = unescape(encodeURIComponent(str));
    const bytes = [];
    for (let i = 0; i < utf8Str.length; i++) {
        bytes.push(utf8Str.charCodeAt(i));
    }
    return bytes;
}

/**
 * Parses WIFI_SETTINGS command payload:
 * [Command(0x01), DataLength, SSID_len, SSID..., Pass_len, Pass..., Checksum]
 * @param {ArrayLike<number>} packet
 * @returns {{ ssid: string, password: string } | null}
 */
export function parseWifiSettings(packet) {
    if (!isValidPacket(packet)) {
        return null;
    }
    const command = packet[0];
    if (command !== 0x01) {
        return null;
    }
    const dataLength = packet[1];
    if (dataLength < 2) {
        return null;
    }

    const ssidLength = packet[2];
    const ssidStart = 3;
    const ssidEnd = ssidStart + ssidLength;

    if (ssidEnd >= packet.length - 1) {
        return null;
    }

    const passLength = packet[ssidEnd];
    const passStart = ssidEnd + 1;
    const passEnd = passStart + passLength;

    // Total data bytes must equal ssidLength + passLength + 2
    if (dataLength !== ssidLength + passLength + 2 || passEnd !== packet.length - 1) {
        return null;
    }

    const ssid = bytesToString(packet, ssidStart, ssidEnd);
    const password = bytesToString(packet, passStart, passEnd);

    return { ssid, password };
}

/**
 * Formats an RPC Result packet.
 * Result packet structure:
 * Byte 1: Command
 * Byte 2: Data length
 * Byte 3..: List of strings: [Length_1, String_1_bytes..., Length_2, String_2_bytes...]
 * Last byte: Checksum
 *
 * @param {number} command
 * @param {string[]} [strings=[]]
 * @returns {Uint8Array}
 */
export function buildRpcResult(command, strings = []) {
    const dataBytes = [];
    for (const str of strings) {
        const bytes = stringToBytes(str);
        if (bytes.length > 255) {
            throw new Error(`String exceeds max length of 255 bytes: ${str}`);
        }
        dataBytes.push(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            dataBytes.push(bytes[i]);
        }
    }

    if (dataBytes.length > 255) {
        throw new Error(`RPC Result data length exceeds 255 bytes`);
    }

    const packet = new Uint8Array(dataBytes.length + 3);
    packet[0] = command;
    packet[1] = dataBytes.length;
    for (let i = 0; i < dataBytes.length; i++) {
        packet[2 + i] = dataBytes[i];
    }
    packet[packet.length - 1] = calculateChecksum(packet, 0, packet.length - 1);
    return packet;
}

/**
 * Helper to manage multi-frame packet reassembly.
 * Improv BLE commands larger than MTU (20 bytes) arrive in chunks.
 */
export class PacketBuffer {
    constructor() {
        this.reset();
    }

    reset() {
        this.buffer = [];
        this.expectedTotalLength = 0;
    }

    /**
     * Feed incoming chunk into buffer.
     * @param {ArrayLike<number>} chunk
     * @returns {'COMPLETE' | 'INCOMPLETE' | 'INVALID'}
     */
    feed(chunk) {
        if (!chunk || chunk.length === 0) {
            return 'INVALID';
        }

        // If this is the start of a packet
        if (this.buffer.length === 0) {
            if (chunk.length < 2) {
                // Cannot even determine data length
                return 'INVALID';
            }
            const dataLength = chunk[1];
            this.expectedTotalLength = dataLength + 3; // cmd + len + data + checksum
        }

        for (let i = 0; i < chunk.length; i++) {
            this.buffer.push(chunk[i]);
        }

        if (this.buffer.length < this.expectedTotalLength) {
            return 'INCOMPLETE';
        }

        if (this.buffer.length === this.expectedTotalLength) {
            if (isValidPacket(this.buffer)) {
                return 'COMPLETE';
            }
            return 'INVALID';
        }

        // buffer length exceeded expectedTotalLength without valid end
        return 'INVALID';
    }

    getPacket() {
        return new Uint8Array(this.buffer);
    }
}
