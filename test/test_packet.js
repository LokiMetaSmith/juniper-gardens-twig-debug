import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateChecksum,
    isValidPacket,
    bytesToString,
    stringToBytes,
    parseWifiSettings,
    buildRpcResult,
    PacketBuffer
} from '../improv-wifi-mod/packet.js';
import BLEExports from '../improv-wifi-mod/consts.js';
const { Commands, StateCodes, ErrorCodes } = BLEExports;

test('calculateChecksum computes LSB of sum correctly', () => {
    // 0x01 + 0x02 + 0x03 = 0x06
    assert.equal(calculateChecksum([0x01, 0x02, 0x03]), 6);
    // Overflow beyond 255: 200 + 100 = 300 => 300 & 0xFF = 44
    assert.equal(calculateChecksum([200, 100]), 44);
    // Sub-range calculation
    assert.equal(calculateChecksum([10, 20, 30, 40], 1, 3), 50);
});

test('stringToBytes and bytesToString handle ASCII and UTF-8 roundtrip', () => {
    const original = "WiFi_Network_123 🚀";
    const bytes = stringToBytes(original);
    const decoded = bytesToString(bytes, 0, bytes.length);
    assert.equal(decoded, original);
});

test('isValidPacket validates correct framing and checksum', () => {
    // Packet: [CMD, LEN, DATA..., CHECKSUM]
    // Cmd: 0x02 (Identify), Len: 0, Checksum: 0x02
    assert.equal(isValidPacket([0x02, 0x00, 0x02]), true);

    // Corrupted checksum
    assert.equal(isValidPacket([0x02, 0x00, 0x03]), false);

    // Mismatched length
    assert.equal(isValidPacket([0x02, 0x01, 0x03]), false);

    // Too short
    assert.equal(isValidPacket([0x02]), false);
    assert.equal(isValidPacket([]), false);
    assert.equal(isValidPacket(null), false);
});

test('parseWifiSettings correctly extracts SSID and password', () => {
    const ssid = "HomeAP";
    const pass = "SuperSecretKey!";
    const ssidBytes = stringToBytes(ssid);
    const passBytes = stringToBytes(pass);

    // Payload: [0x01, totalLen, ssidLen, ...ssid, passLen, ...pass, checksum]
    const dataBytes = [ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];
    const raw = [0x01, dataBytes.length, ...dataBytes];
    const cs = calculateChecksum(raw);
    const packet = [...raw, cs];

    const parsed = parseWifiSettings(packet);
    assert.notEqual(parsed, null);
    assert.equal(parsed.ssid, ssid);
    assert.equal(parsed.password, pass);
});

test('parseWifiSettings rejects corrupted or malformed packets', () => {
    // Checksum invalid
    assert.equal(parseWifiSettings([0x01, 0x04, 0x01, 0x41, 0x01, 0x42, 0x00]), null);
    // Wrong command
    assert.equal(parseWifiSettings([0x02, 0x00, 0x02]), null);
    // Truncated data length
    assert.equal(parseWifiSettings([0x01, 0x01, 0x01]), null);
});

test('buildRpcResult generates valid Improv RPC result packet', () => {
    const url = "http://192.168.1.100";
    const resultPacket = buildRpcResult(Commands.WIFI_SETTINGS, [url]);

    assert.equal(isValidPacket(resultPacket), true);
    assert.equal(resultPacket[0], Commands.WIFI_SETTINGS);
    const dataLen = resultPacket[1];
    // string 1 length
    const str1Len = resultPacket[2];
    assert.equal(str1Len, url.length);
    assert.equal(dataLen, url.length + 1);

    const extractedUrl = bytesToString(resultPacket, 3, 3 + str1Len);
    assert.equal(extractedUrl, url);
});

test('buildRpcResult handles empty list of strings', () => {
    const resultPacket = buildRpcResult(Commands.WIFI_SETTINGS, []);
    assert.equal(isValidPacket(resultPacket), true);
    assert.equal(resultPacket[0], Commands.WIFI_SETTINGS);
    assert.equal(resultPacket[1], 0);
    // cmd(0x01) + len(0) = 1 => checksum is 1
    assert.equal(resultPacket[2], 0x01);
});

test('PacketBuffer handles single-packet frames', () => {
    const buffer = new PacketBuffer();
    // Packet: [0x02, 0x00, 0x02] (IDENTIFY)
    const status = buffer.feed([0x02, 0x00, 0x02]);
    assert.equal(status, 'COMPLETE');
    const packet = buffer.getPacket();
    assert.deepEqual(Array.from(packet), [0x02, 0x00, 0x02]);
});

test('PacketBuffer reassembles multi-packet chunks (> 20 bytes)', () => {
    const buffer = new PacketBuffer();

    const ssid = "MyVeryLongCorporateNetworkSSID"; // 30 bytes
    const pass = "ExtremelyLongAndComplicatedPassword123456789"; // 43 bytes
    const ssidBytes = stringToBytes(ssid);
    const passBytes = stringToBytes(pass);

    const dataBytes = [ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];
    const raw = [0x01, dataBytes.length, ...dataBytes];
    const cs = calculateChecksum(raw);
    const fullPacket = [...raw, cs];

    // Total packet length will be ~ 78 bytes. Split into 20-byte chunks
    const chunkSize = 20;
    const chunks = [];
    for (let i = 0; i < fullPacket.length; i += chunkSize) {
        chunks.push(fullPacket.slice(i, i + chunkSize));
    }

    assert.ok(chunks.length > 3);

    for (let i = 0; i < chunks.length - 1; i++) {
        const res = buffer.feed(chunks[i]);
        assert.equal(res, 'INCOMPLETE', `Chunk ${i} should be INCOMPLETE`);
    }

    const finalRes = buffer.feed(chunks[chunks.length - 1]);
    assert.equal(finalRes, 'COMPLETE');

    const assembled = buffer.getPacket();
    assert.deepEqual(Array.from(assembled), fullPacket);

    const parsed = parseWifiSettings(assembled);
    assert.equal(parsed.ssid, ssid);
    assert.equal(parsed.password, pass);
});

test('PacketBuffer reports INVALID on corrupted multi-packet chunking', () => {
    const buffer = new PacketBuffer();
    // Feed header claiming length 10
    const chunk1 = [0x01, 10, 1, 2, 3];
    assert.equal(buffer.feed(chunk1), 'INCOMPLETE');

    // Feed remaining bytes but with bad checksum
    const chunk2 = [4, 5, 6, 7, 8, 9, 10, 0x00]; // 0x00 won't match checksum
    assert.equal(buffer.feed(chunk2), 'INVALID');
});
