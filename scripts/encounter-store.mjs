import { DatabaseSync } from 'node:sqlite';

export const owners = ['USER_101', 'USER_202'];
const DEVICE_ID = /^[0-9a-f]{12}$/;
const EVENT_ID = /^[0-9a-f]{32}$/;
const USER_ID = /^[A-Za-z0-9_.@-]{1,64}$/;

export class InvalidBatch extends Error {}

export function projectEncounters(records, profileNames = new Map()) {
  const accounts = Object.fromEntries(owners.map((owner) => [owner, []]));
  const saved = new Map();
  for (const record of records) {
    if (record?.status !== 'confirmed' || !owners.includes(record.ownerId)) continue;
    validateRecord(record);
    const { ownerId, deviceId, eventId, peerId, timestampMs } = record;
    const key = `${ownerId}/${deviceId}/${eventId}`;
    const previous = saved.get(key);
    if (previous) {
      previous.timestampMs ??= timestampMs;
      continue;
    }
    const clicks = accounts[ownerId];
    const click = { id: `${ownerId}-${clicks.length}`, peerId, peerName: profileNames.get(peerId) ?? null, timestampMs };
    saved.set(key, click);
    clicks.push(click);
  }
  return accounts;
}

function validateRecord({ deviceId, eventId, peerId, timestampMs }) {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)
    || typeof eventId !== 'string' || !EVENT_ID.test(eventId)
    || typeof peerId !== 'string' || !USER_ID.test(peerId)
    || (timestampMs !== null && !(Number.isSafeInteger(timestampMs) && timestampMs > 0
      && Number.isFinite(new Date(timestampMs).getTime())))) {
    throw new InvalidBatch('An encounter has invalid fields.');
  }
}

export function openEncounterStore(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS encounters (
      ownerId TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      eventId TEXT NOT NULL,
      peerId TEXT NOT NULL,
      timestampMs INTEGER,
      PRIMARY KEY (ownerId, deviceId, eventId)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS demo_profile_names (
      ownerId TEXT PRIMARY KEY NOT NULL,
      displayName TEXT NOT NULL
    ) STRICT;
  `);
  const listNames = database.prepare('SELECT ownerId, displayName FROM demo_profile_names');
  const saveName = database.prepare(`
    INSERT INTO demo_profile_names (ownerId, displayName) VALUES (?, ?)
    ON CONFLICT (ownerId) DO UPDATE SET displayName = excluded.displayName
  `);
  const select = database.prepare("SELECT *, 'confirmed' AS status FROM encounters ORDER BY rowid");
  const find = database.prepare('SELECT peerId FROM encounters WHERE ownerId = ? AND deviceId = ? AND eventId = ?');
  const save = database.prepare(`
    INSERT INTO encounters (ownerId, deviceId, eventId, peerId, timestampMs) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ownerId, deviceId, eventId)
    DO UPDATE SET timestampMs = COALESCE(encounters.timestampMs, excluded.timestampMs)
  `);

  return {
    list: () => select.all(),
    profileNames: () => new Map(listNames.all().map(({ ownerId, displayName }) => [ownerId, displayName])),
    saveProfileName(profile) {
      const { ownerId, displayName } = profile ?? {};
      const name = typeof displayName === 'string' ? displayName.trim() : '';
      if (!owners.includes(ownerId) || !name || name.length > 80 || /\p{Cc}/u.test(name)) {
        throw new InvalidBatch('Choose a demo bracelet and enter a name of up to 80 characters.');
      }
      saveName.run(ownerId, name);
    },
    saveBatch(batch) {
      const { ownerId, deviceId, records } = batch ?? {};
      if (!owners.includes(ownerId) || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)
        || !Array.isArray(records) || records.length < 1 || records.length > 32) {
        throw new InvalidBatch('Choose one demo account and sync at most 32 encounters.');
      }
      const accepted = new Set();
      for (const record of records) {
        if (record?.status !== 'confirmed' || record.ownerId !== ownerId || record.deviceId !== deviceId
          || record.peerId === ownerId || accepted.has(record.eventId)) {
          throw new InvalidBatch('The batch contains an unconfirmed, duplicate, or mismatched encounter.');
        }
        validateRecord(record);
        accepted.add(record.eventId);
      }

      database.exec('BEGIN IMMEDIATE');
      try {
        for (const { eventId, peerId, timestampMs } of records) {
          const existing = find.get(ownerId, deviceId, eventId);
          if (existing && existing.peerId !== peerId) {
            throw new InvalidBatch('This encounter ID is already saved with a different peer.');
          }
          save.run(ownerId, deviceId, eventId, peerId, timestampMs);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return [...accepted];
    },
    close: () => database.close(),
  };
}
