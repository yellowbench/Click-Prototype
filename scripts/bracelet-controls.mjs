import { BraceletClient } from './bracelet-client.mjs';

function errorMessage(error) {
  if (error.name === 'NotFoundError') return 'No bracelet selected. Make sure it is powered on and try again.';
  if (error.name === 'NetworkError' || error.code === 'DISCONNECTED') {
    return 'Connection lost. Bring the bracelet closer and reconnect.';
  }
  return error.message;
}

export function createBraceletControls({ update, updateTimeline, selectBraceletOwner }) {
  let bracelet;
  let connected = null;
  let busy = false;
  let closed = false;
  const profileUpdates = typeof window.BroadcastChannel === 'function'
    ? new window.BroadcastChannel('click-local-demo-profiles') : null;

  async function requestJson(url, body) {
    const options = body === undefined ? undefined : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The local Click preview could not finish the request.');
    return result;
  }

  async function refreshTimeline() {
    const { timeline } = await requestJson('/api/encounters/timeline');
    if (!closed) updateTimeline(timeline);
  }

  function refreshOnFocus() {
    refreshTimeline().catch(() => {});
  }

  window.addEventListener('focus', refreshOnFocus);
  profileUpdates?.addEventListener('message', refreshOnFocus);

  function publish(message = '') {
    if (!closed) update({ braceletInfo: connected, braceletBusy: busy, braceletMessage: message });
  }

  function openClient() {
    const next = new BraceletClient({
      onDisconnect() {
        if (bracelet !== next) return;
        connected = null;
        publish('Bracelet disconnected.');
      },
    });
    bracelet = next;
    return next;
  }

  function dropConnection() {
    const old = bracelet;
    bracelet = null;
    connected = null;
    old?.disconnect();
  }

  async function run(message, action) {
    if (busy || closed) return;
    busy = true;
    publish(message);
    let result;
    try {
      result = await action();
    } catch (error) {
      result = errorMessage(error);
    } finally {
      busy = false;
      publish(result);
    }
  }

  async function save(client, ownerId) {
    publish('Reading and saving encounters…');
    await client.setTime();
    const result = await client.sync(async (records, info) => {
      if (info.userId !== ownerId || info.deviceId !== connected?.deviceId) {
        throw new Error('The bracelet’s identity changed. Disconnect and pair it again.');
      }
      const receipt = await requestJson('/api/encounters/batch', { ownerId, deviceId: info.deviceId, records });
      if (!closed) updateTimeline(receipt.timeline);
      return receipt.acceptedEventIds;
    });

    const count = result.acknowledged.length;
    if (count === 0) await refreshTimeline();
    return count > 0
      ? `Synced ${count} ${count === 1 ? 'encounter' : 'encounters'}. Disconnect before tapping.`
      : result.info.pendingCount > 0
        ? 'No confirmed encounters to sync. Retry the pending tap with the same bracelet.'
        : 'No encounters to sync. Disconnect before tapping.';
  }

  return {
    async saveProfileName(ownerId, displayName) {
      const { timeline } = await requestJson('/api/demo-profile', { ownerId, displayName });
      if (!closed) {
        updateTimeline(timeline);
        profileUpdates?.postMessage('updated');
      }
    },
    choose() {
      return run('Choose your bracelet in Chrome…', async () => {
        dropConnection();
        const client = openClient();
        // Start the chooser inside the click handler, before any other await.
        const info = await client.connect();
        if (closed) return;
        if (!selectBraceletOwner(info.userId)) {
          dropConnection();
          return 'Choose one of the two bracelets configured for this local demo.';
        }
        connected = info;
        return save(client, info.userId);
      });
    },
    sync() {
      if (!connected) return;
      return run('Reading and saving encounters…', () => save(bracelet, connected.userId));
    },
    disconnect() {
      if (busy) return;
      dropConnection();
      publish();
    },
    close() {
      closed = true;
      window.removeEventListener('focus', refreshOnFocus);
      profileUpdates?.close();
      dropConnection();
    },
  };
}

window.createClickBraceletControls = createBraceletControls;
