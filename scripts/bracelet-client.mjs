// Click GATT protocol v1. No framework or dependencies; import in the real website.
export const UUID = Object.freeze({
  service: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  identity: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  control: 'beb5483e-36e1-4688-b7f5-ea07361b26a9',
  status: 'beb5483e-36e1-4688-b7f5-ea07361b26aa',
  data: 'beb5483e-36e1-4688-b7f5-ea07361b26ab',
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const EVENT = /^[a-f0-9]{32}$/;
export const validUserId = value => typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(value);

export class BraceletError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BraceletError'; this.code = code; }
}
export function parseInfo(response) {
  const p = response.split('|');
  if (p.length !== 10 || p[0] !== 'OK' || p[1] !== 'INFO' || p[2] !== '1' ||
      !/^[a-f0-9]{12}$/.test(p[3]) || !validUserId(p[4]) ||
      !p.slice(5, 9).every(n => /^\d+$/.test(n)) || !/^[a-f0-9]{16}$/.test(p[9]) ||
      Number(p[8]) !== 32 || Number(p[5]) > 32 || Number(p[6]) > Number(p[5]) || Number(p[7]) > 1) {
    throw new BraceletError('BAD_RESPONSE', 'Invalid device information or unsupported firmware.');
  }
  return { protocolVersion: 1, deviceId: p[3], userId: p[4], recordCount: +p[5],
    pendingCount: +p[6], clockSet: p[7] === '1', capacity: +p[8], bootId: p[9] };
}
export function parseRecord(response) {
  if (response === 'OK|EMPTY') return null;
  const p = response.split('|');
  if (p.length !== 11 || p[0] !== 'OK' || p[1] !== 'REC' || !EVENT.test(p[2]) ||
      !validUserId(p[3]) || !validUserId(p[4]) || !/^[a-f0-9]{12}$/.test(p[5]) ||
      !/^[a-f0-9]{12}$/.test(p[6]) || !/^[a-f0-9]{16}$/.test(p[7]) ||
      !/^\d+$/.test(p[8]) || !/^\d+$/.test(p[9]) || !['1', '2'].includes(p[10]) ||
      !Number.isSafeInteger(+p[8]) || !Number.isSafeInteger(+p[9])) {
    throw new BraceletError('BAD_RESPONSE', 'Invalid encounter record; nothing was acknowledged.');
  }
  return { eventId: p[2], ownerId: p[3], peerId: p[4], deviceId: p[5], peerDeviceId: p[6],
    bootId: p[7], uptimeMs: +p[8], timestampMs: +p[9] || null,
    status: p[10] === '2' ? 'confirmed' : 'pending' };
}

// Exported transport makes packet framing independently testable with fake GATT.
export class GattTransport {
  constructor({ control, status, data, connected = () => true, timeoutMs = 7000 }) {
    Object.assign(this, { control, status, data, connected, timeoutMs });
  }
  async command(command) {
    if (!/^[\x20-\x7e]{1,256}$/.test(command)) throw new BraceletError('BAD_COMMAND');
    if (!this.connected()) throw new BraceletError('DISCONNECTED');
    const write = bytes => this.control.writeValueWithResponse(new Uint8Array(bytes));
    await write([1]);
    const bytes = encoder.encode(command);
    for (let i = 0; i < bytes.length; i += 19) await write([2, ...bytes.slice(i, i + 19)]);
    await write([3]);
    const start = Date.now(); let length;
    while (Date.now() - start < this.timeoutMs) {
      if (!this.connected()) throw new BraceletError('DISCONNECTED');
      const state = await this.status.readValue();
      if (state.byteLength !== 4 || state.getUint8(0) !== 1) throw new BraceletError('BAD_STATUS');
      if (state.getUint8(1) === 2) { length = state.getUint16(2, true); break; }
      if (state.getUint8(1) !== 1) throw new BraceletError('BAD_STATUS', 'Device reset or command was not accepted.');
      await sleep(25);
    }
    if (length === undefined) throw new BraceletError('TIMEOUT', 'Device did not finish the command. Disconnect and reconnect.');
    if (!length || length > 512) throw new BraceletError('BAD_LENGTH');
    const result = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 20) {
      await write([4, offset & 255, offset >> 8]);
      const page = await this.data.readValue();
      const expected = Math.min(20, length - offset);
      if (page.byteLength !== expected) throw new BraceletError('TRUNCATED_RESPONSE');
      result.set(new Uint8Array(page.buffer, page.byteOffset, page.byteLength), offset);
    }
    const response = decoder.decode(result);
    if (response.startsWith('ERR|')) throw new BraceletError(response.slice(4));
    if (!response.startsWith('OK|')) throw new BraceletError('BAD_RESPONSE');
    return response;
  }
}

export class BraceletClient {
  #tail = Promise.resolve();
  #transport = null;
  #connecting = false;
  #generation = 0;
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onDisconnect = () => {}, transport = null } = {}) {
    this.bluetooth = bluetooth; this.onDisconnect = onDisconnect; this.#transport = transport;
    this.device = null;
  }
  get connected() { return !!this.#transport; }
  async connect() {
    if (this.#connecting || this.connected) throw new BraceletError('BUSY');
    if (!this.bluetooth) throw new BraceletError('UNSUPPORTED', 'Open this page in Windows or Android Chrome with Bluetooth enabled.');
    if (globalThis.isSecureContext === false) throw new BraceletError('INSECURE', 'Use HTTPS or http://localhost.');
    this.#connecting = true;
    const generation = ++this.#generation;
    try {
      // Must be called directly from a user click: do not defer the chooser to a queue.
      const device = await this.bluetooth.requestDevice({ filters: [{ services: [UUID.service] }] });
      if (generation !== this.#generation) throw new BraceletError('DISCONNECTED');
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => {
        if (this.device === device) { this.#transport = null; ++this.#generation; this.onDisconnect(); }
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(UUID.service);
      // Serialize GATT discovery too: Windows rejects concurrent GATT operations.
      const control = await service.getCharacteristic(UUID.control);
      const status = await service.getCharacteristic(UUID.status);
      const data = await service.getCharacteristic(UUID.data);
      if (generation !== this.#generation) { device.gatt.disconnect(); throw new BraceletError('DISCONNECTED'); }
      this.#transport = new GattTransport({ control, status, data, connected: () => device.gatt.connected });
      return await this.getInfo();
    } catch (error) { this.disconnect(); throw error; }
    finally { this.#connecting = false; }
  }
  disconnect() {
    ++this.#generation; this.#transport = null;
    const device = this.device;
    this.device = null;
    if (device?.gatt.connected) device.gatt.disconnect();
  }
  #transaction(fn) {
    const generation = this.#generation;
    const job = this.#tail.then(() => {
      if (generation !== this.#generation || !this.#transport) throw new BraceletError('DISCONNECTED');
      return fn(this.#transport);
    });
    this.#tail = job.catch(() => {}); return job;
  }
  getInfo() { return this.#transaction(async t => parseInfo(await t.command('INFO'))); }
  provision(userId) {
    if (!validUserId(userId)) return Promise.reject(new BraceletError('BAD_ID', 'Use 1–64 letters, numbers, underscores, hyphens, periods, or @.'));
    return this.#transaction(async t => {
      const response = await t.command(`ID|${userId}`);
      if (response !== `OK|ID|${userId}`) throw new BraceletError('BAD_RESPONSE');
      return parseInfo(await t.command('INFO'));
    });
  }
  setTime(epochMs = Date.now()) {
    if (!Number.isSafeInteger(epochMs) || epochMs < 1577836800000 || epochMs > 4102444800000)
      return Promise.reject(new BraceletError('BAD_TIME'));
    return this.#transaction(async t => {
      if (await t.command(`TIME|${epochMs}`) !== 'OK|TIME') throw new BraceletError('BAD_RESPONSE');
    });
  }
  async #readAll(t) {
    const info = parseInfo(await t.command('INFO')), records = [];
    for (let slot = 0; slot < info.capacity; ++slot) {
      const record = parseRecord(await t.command(`LIST|${slot}`));
      if (record) {
        if (record.ownerId !== info.userId || record.deviceId !== info.deviceId) throw new BraceletError('OWNER_MISMATCH');
        records.push(record);
      }
    }
    if (new Set(records.map(r => r.eventId)).size !== records.length) throw new BraceletError('DUPLICATE_EVENT');
    return { info, records };
  }
  readRecords() { return this.#transaction(t => this.#readAll(t)); }
  // persist MUST finish a durable write, then return the event IDs it actually accepted.
  // Backend should deduplicate by (ownerId, deviceId, eventId).
  sync(persist) {
    if (typeof persist !== 'function') return Promise.reject(new TypeError('A durable persistence callback is required.'));
    return this.#transaction(async t => {
      const snapshot = await this.#readAll(t);
      const confirmed = snapshot.records.filter(r => r.status === 'confirmed');
      if (!confirmed.length) return { ...snapshot, acknowledged: [] };
      const accepted = await persist(confirmed, snapshot.info);
      const allowed = new Set(confirmed.map(r => r.eventId));
      if (!Array.isArray(accepted) || accepted.some(id => !allowed.has(id)) || new Set(accepted).size !== accepted.length)
        throw new BraceletError('BAD_RECEIPT', 'Persistence returned invalid acknowledgments; device records were retained.');
      const acknowledged = [];
      for (const id of accepted) {
        if (await t.command(`ACK|${id}`) !== 'OK|ACK') throw new BraceletError('BAD_RESPONSE');
        acknowledged.push(id);
      }
      return { ...snapshot, acknowledged };
    });
  }
}
