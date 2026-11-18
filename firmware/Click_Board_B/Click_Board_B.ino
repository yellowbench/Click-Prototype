/*
  CLICK BRACELET - BOARD B
  Self-contained copy of the working ESP32 hackathon firmware.
  Open this .ino file in Arduino IDE. Keep it in its matching sketch folder.

  Hardware
  - ESP32 Dev Module, 4 MB flash
  - Button between GPIO18 (D18) and GND; internal pull-up enabled
  - LED: D5 -> 220 ohm resistor -> anode (+); cathode (-) -> GND

  Software used
  - Arduino IDE 2.3.11
  - esp32 by Espressif Systems board package 3.3.12
  - BLE and Preferences libraries bundled with the ESP32 board package

  Arduino IDE settings
  - Board: ESP32 Dev Module
  - Partition Scheme: Huge APP (3MB No OTA/1MB SPIFFS)
  - Upload Speed: 115200; Serial Monitor: 115200 baud
  - Erase All Flash Before Sketch Upload: Disabled

  Operation
  - Default ID: USER_202; an ID saved earlier on the board takes precedence
  - Disconnect both boards from the browser before a physical tap
  - Bring boards face-to-face, then press one button
  - Serial commands: t = tap, i = device information
  - Reconnect to the existing Click website to sync the saved encounters
  - RSSI -25 is the demo's proximity filter; it does not measure centimeters
  - This sketch retains the existing click_v1 record format and BLE protocol
*/

// Final working demo settings. A button press connects GPIO18 to ground.
#define BUTTON_PIN 18
#define FEEDBACK_PIN 5
#define RSSI_THRESHOLD -25
#define RECORD_CAPACITY 32

#include <Arduino.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEScan.h>
#include <BLEClient.h>
#include <esp_timer.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

static const char *SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
static const char *ID_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
static const char *CONTROL_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a9";
static const char *STATUS_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26aa";
static const char *DATA_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26ab";
static const uint32_t RECORD_VERSION = 1;
enum RecordState : uint8_t { EMPTY = 0, REC_PENDING = 1, CONFIRMED = 2, SYNCED = 3 };
struct Record {
  uint32_t version;
  uint32_t sequence;
  uint64_t uptimeMs;
  uint64_t unixMs;
  char eventId[33];
  char ownerId[65];
  char peerId[65];
  char peerDevice[13];
  char bootId[17];
  uint8_t state;
};
// Explicit declarations for Arduino's automatic sketch preprocessing.
static bool saveRecord(int slot, const Record &record);
static Record makeRecord(const String &event, const String &peer, const String &peerDevice, uint8_t state);

static Record records[RECORD_CAPACITY] = {};
static Preferences prefs;
static String userId, deviceId, bootId;
static bool storageOK = false, oledOK = false, outbound = false;
static uint64_t clockEpoch = 0, clockUptime = 0;
static BLEServer *server;
static BLEClient *client;
static BLECharacteristic *identityChar;
static SemaphoreHandle_t transportLock;
static volatile bool incomingConnected = false, restartAdvertising = false;
static String rxCommand, txResponse;
static uint8_t transportState = 0; // 0=collecting/idle, 1=processing, 2=ready
static bool commandQueued = false, rxOverflow = false;
static uint16_t responseOffset = 0;
static uint32_t sessionGeneration = 0;
static uint32_t feedbackUntil = 0, readyAt = 0, nextTapAt = 0;

static uint64_t uptime() { return esp_timer_get_time() / 1000ULL; }
static String number64(uint64_t n) {
  char b[24]; snprintf(b, sizeof(b), "%llu", (unsigned long long)n); return String(b);
}
static String randomHex(int words) {
  String s; char b[9];
  for (int i = 0; i < words; ++i) { snprintf(b, sizeof(b), "%08lx", (unsigned long)esp_random()); s += b; }
  return s;
}
static bool token(const String &s, size_t maxLength) {
  if (!s.length() || s.length() > maxLength) return false;
  for (unsigned int i = 0; i < s.length(); ++i) {
    char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == '@')) return false;
  }
  return true;
}
static bool hexToken(const String &s, size_t length) {
  if (s.length() != length) return false;
  for (unsigned int i = 0; i < s.length(); ++i)
    if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  return true;
}
static bool unsignedNumber(const String &s) {
  if (!s.length() || s.length() > 15) return false;
  for (unsigned int i = 0; i < s.length(); ++i) if (s[i] < '0' || s[i] > '9') return false;
  return true;
}
static String field(const String &s, int index) {
  int start = 0;
  for (int i = 0; i < index; ++i) { start = s.indexOf('|', start); if (start < 0) return ""; ++start; }
  int end = s.indexOf('|', start); return end < 0 ? s.substring(start) : s.substring(start, end);
}
static int fields(const String &s) {
  int n = 1; for (unsigned int i = 0; i < s.length(); ++i) if (s[i] == '|') ++n; return n;
}
static int activeCount() {
  int n = 0; for (auto &r : records) if (r.state == REC_PENDING || r.state == CONFIRMED) ++n; return n;
}
static int pendingCount() {
  int n = 0; for (auto &r : records) if (r.state == REC_PENDING) ++n; return n;
}
static void show(const String &title, const String &detail = "") {
  Serial.println(title + " | " + detail);
}
static void ready() {
  show(storageOK ? "READY TO TAP" : "STORAGE ERROR", userId + " / " + String(activeCount()) + " logs");
}
static void success(const String &peer) {
  show("ENCOUNTER SAVED", peer);
  digitalWrite(FEEDBACK_PIN, HIGH); feedbackUntil = millis() + 300;
  readyAt = millis() + 2500;
}
static bool saveRecord(int slot, const Record &record) {
  if (!storageOK) return false;
  String key = "r" + String(slot);
  if (prefs.putBytes(key.c_str(), &record, sizeof(record)) != sizeof(record)) return false;
  records[slot] = record;
  return true;
}
static int findEvent(const String &id) {
  for (int i = 0; i < RECORD_CAPACITY; ++i) if (records[i].state && id == records[i].eventId) return i;
  return -1;
}
static int freeSlot() {
  int oldest = -1;
  for (int i = 0; i < RECORD_CAPACITY; ++i) {
    if (records[i].state == EMPTY) return i;
    if (records[i].state == SYNCED && (oldest < 0 || records[i].sequence < records[oldest].sequence)) oldest = i;
  }
  return oldest;
}
static Record makeRecord(const String &event, const String &peer, const String &peerDevice, uint8_t state) {
  Record r = {}; r.version = RECORD_VERSION; r.sequence = 1;
  for (auto &old : records) if (old.sequence >= r.sequence) r.sequence = old.sequence + 1;
  r.uptimeMs = uptime(); r.unixMs = clockEpoch ? clockEpoch + r.uptimeMs - clockUptime : 0;
  event.toCharArray(r.eventId, sizeof(r.eventId)); userId.toCharArray(r.ownerId, sizeof(r.ownerId));
  peer.toCharArray(r.peerId, sizeof(r.peerId)); peerDevice.toCharArray(r.peerDevice, sizeof(r.peerDevice));
  bootId.toCharArray(r.bootId, sizeof(r.bootId)); r.state = state; return r;
}
static String info() {
  return "OK|INFO|1|" + deviceId + "|" + userId + "|" + String(activeCount()) + "|" +
    String(pendingCount()) + "|" + (clockEpoch ? "1" : "0") + "|" + String(RECORD_CAPACITY) + "|" + bootId;
}
static String executeCommand(const String &cmd) {
  String op = field(cmd, 0);
  if (op == "INFO" && fields(cmd) == 1) return info();
  if (!storageOK) return "ERR|STORAGE";
  if (op == "ID" && fields(cmd) == 2) {
    String id = field(cmd, 1);
    if (!token(id, 64)) return "ERR|BAD_ID";
    if (id != userId && activeCount()) return "ERR|UNSYNCED_RECORDS";
    if (prefs.putString("my_id", id) != id.length()) return "ERR|STORAGE";
    userId = id; identityChar->setValue(userId); show("ID SAVED", userId);
    return "OK|ID|" + userId;
  }
  if (op == "TIME" && fields(cmd) == 2) {
    String value = field(cmd, 1);
    if (!unsignedNumber(value)) return "ERR|BAD_TIME";
    uint64_t ms = strtoull(value.c_str(), nullptr, 10);
    if (ms < 1577836800000ULL || ms > 4102444800000ULL) return "ERR|BAD_TIME";
    clockEpoch = ms; clockUptime = uptime();
    // Recover time only for records from this powered-on session.
    for (int i = 0; i < RECORD_CAPACITY; ++i) {
      Record r = records[i];
      if ((r.state == REC_PENDING || r.state == CONFIRMED) && !r.unixMs && bootId == r.bootId) {
        r.unixMs = ms - (clockUptime - r.uptimeMs);
        if (!saveRecord(i, r)) return "ERR|STORAGE";
      }
    }
    return "OK|TIME";
  }
  if (op == "LIST" && fields(cmd) == 2) {
    String value = field(cmd, 1);
    if (!unsignedNumber(value) || value.toInt() >= RECORD_CAPACITY) return "ERR|BAD_SLOT";
    Record &r = records[value.toInt()];
    if (r.state == EMPTY || r.state == SYNCED) return "OK|EMPTY";
    return "OK|REC|" + String(r.eventId) + "|" + r.ownerId + "|" + r.peerId + "|" + deviceId + "|" +
      r.peerDevice + "|" + r.bootId + "|" + number64(r.uptimeMs) + "|" + number64(r.unixMs) + "|" + String(r.state);
  }
  if (op == "ACK" && fields(cmd) == 2) {
    String id = field(cmd, 1); if (!hexToken(id, 32)) return "ERR|BAD_EVENT";
    int slot = findEvent(id);
    if (slot < 0) return "OK|ACK"; // Already removed/reused: idempotent.
    Record r = records[slot];
    if (r.state == REC_PENDING) return "ERR|PENDING";
    if (r.state != SYNCED) { r.state = SYNCED; if (!saveRecord(slot, r)) return "ERR|STORAGE"; }
    return "OK|ACK";
  }
  if (op == "OFFER" && fields(cmd) == 5) {
    String event = field(cmd, 1), peer = field(cmd, 2), peerDev = field(cmd, 3), expectedOwner = field(cmd, 4);
    if (!hexToken(event, 32) || !token(peer, 64) || !hexToken(peerDev, 12)) return "ERR|BAD_OFFER";
    if (expectedOwner != userId) return "ERR|IDENTITY_CHANGED";
    if (peer == userId || peerDev == deviceId) return "ERR|SELF";
    int slot = findEvent(event);
    if (slot >= 0) {
      Record &r = records[slot];
      if (peer != r.peerId || peerDev != r.peerDevice || userId != r.ownerId || r.state == REC_PENDING) return "ERR|EVENT_CONFLICT";
      return "OK|SAVED|" + event;
    }
    // A pending outgoing exchange must be resolved before accepting another one.
    if (pendingCount()) return "ERR|PENDING";
    slot = freeSlot(); if (slot < 0) return "ERR|FULL";
    Record r = makeRecord(event, peer, peerDev, CONFIRMED);
    if (!saveRecord(slot, r)) return "ERR|STORAGE";
    success(peer); return "OK|SAVED|" + event;
  }
  return "ERR|BAD_COMMAND";
}

// BLE callbacks only handle bounded transport buffers. Flash/UI work runs in loop().
class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String bytes = c->getValue();
    xSemaphoreTake(transportLock, portMAX_DELAY);
    if (!bytes.length() || bytes.length() > 20 || transportState == 1) { xSemaphoreGive(transportLock); return; }
    uint8_t op = bytes[0];
    if (op == 1 && bytes.length() == 1) {
      rxCommand = ""; txResponse = ""; transportState = 0; rxOverflow = false; responseOffset = 0;
    } else if (op == 2 && transportState == 0) {
      if (rxCommand.length() + bytes.length() - 1 > 256) rxOverflow = true;
      else for (unsigned int i = 1; i < bytes.length(); ++i) {
        if (bytes[i] < 32 || bytes[i] > 126) rxOverflow = true;
        rxCommand += bytes[i];
      }
    } else if (op == 3 && bytes.length() == 1 && transportState == 0) {
      if (rxOverflow || !rxCommand.length()) { txResponse = "ERR|BAD_FRAME"; transportState = 2; }
      else { commandQueued = true; transportState = 1; }
    } else if (op == 4 && bytes.length() == 3 && transportState == 2) {
      responseOffset = (uint8_t)bytes[1] | ((uint16_t)(uint8_t)bytes[2] << 8);
    }
    xSemaphoreGive(transportLock);
  }
};
class StatusCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *c) override {
    xSemaphoreTake(transportLock, portMAX_DELAY);
    uint16_t n = txResponse.length();
    uint8_t status[] = {1, transportState, (uint8_t)n, (uint8_t)(n >> 8)};
    c->setValue(status, sizeof(status)); xSemaphoreGive(transportLock);
  }
};
class DataCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic *c) override {
    xSemaphoreTake(transportLock, portMAX_DELAY);
    String page = responseOffset < txResponse.length() ? txResponse.substring(responseOffset, responseOffset + 20) : "";
    c->setValue(page); xSemaphoreGive(transportLock);
  }
};
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override {
    incomingConnected = true;
    xSemaphoreTake(transportLock, portMAX_DELAY);
    ++sessionGeneration; rxCommand = ""; txResponse = ""; transportState = 0;
    commandQueued = false; rxOverflow = false; responseOffset = 0;
    xSemaphoreGive(transportLock);
  }
  void onDisconnect(BLEServer *s) override {
    incomingConnected = false; restartAdvertising = true;
    xSemaphoreTake(transportLock, portMAX_DELAY);
    ++sessionGeneration; commandQueued = false; transportState = 0;
    xSemaphoreGive(transportLock);
  }
};
static void serviceCommand() {
  String cmd; uint32_t generation = 0;
  xSemaphoreTake(transportLock, portMAX_DELAY);
  if (commandQueued) { cmd = rxCommand; generation = sessionGeneration; commandQueued = false; }
  xSemaphoreGive(transportLock);
  if (!cmd.length()) return;
  String result = executeCommand(cmd);
  xSemaphoreTake(transportLock, portMAX_DELAY);
  if (generation == sessionGeneration) { txResponse = result; responseOffset = 0; transportState = 2; }
  xSemaphoreGive(transportLock);
}
static String peerCommand(BLERemoteCharacteristic *control, BLERemoteCharacteristic *status,
                          BLERemoteCharacteristic *data, const String &command) {
  uint8_t start = 1, execute = 3;
  if (!control->writeValue(&start, 1, true)) return "ERR|LINK";
  for (unsigned int offset = 0; offset < command.length(); offset += 19) {
    uint8_t frame[20] = {2}; size_t n = min((unsigned int)19, command.length() - offset);
    memcpy(frame + 1, command.c_str() + offset, n);
    if (!control->writeValue(frame, n + 1, true)) return "ERR|LINK";
  }
  if (!control->writeValue(&execute, 1, true)) return "ERR|LINK";
  uint32_t started = millis(); uint16_t length = 0;
  while (client->isConnected() && millis() - started < 5000) {
    String bytes = status->readValue();
    if (bytes.length() == 4 && (uint8_t)bytes[0] == 1 && bytes[1] == 2) {
      length = (uint8_t)bytes[2] | ((uint16_t)(uint8_t)bytes[3] << 8); break;
    }
    delay(15);
  }
  if (!length || length > 512) return "ERR|TIMEOUT";
  String result;
  for (uint16_t offset = 0; offset < length; offset += 20) {
    uint8_t page[] = {4, (uint8_t)offset, (uint8_t)(offset >> 8)};
    if (!control->writeValue(page, sizeof(page), true)) return "ERR|LINK";
    String chunk = data->readValue();
    if (chunk.length() != min((int)20, (int)(length - offset))) return "ERR|LINK";
    result += chunk;
  }
  return result;
}
static void exchange() {
  if (incomingConnected) { show("DISCONNECT WEBSITE", "Then press button"); readyAt = millis() + 2500; return; }
  if (!storageOK) { show("STORAGE ERROR"); return; }
  outbound = true; BLEDevice::getAdvertising()->stop();
  show("FINDING BRACELET", "Keep boards close");
  BLEScan *scanner = BLEDevice::getScan();
  BLEScanResults *found = scanner->start(3, false);
  int best = -1, strongest = -128, pending = -1;
  for (int i = 0; i < RECORD_CAPACITY; ++i) if (records[i].state == REC_PENDING) { pending = i; break; }
  if (found) for (int i = 0; i < found->getCount(); ++i) {
    BLEAdvertisedDevice d = found->getDevice(i);
    // For retries select the exact physical device whose durable pending record exists.
    String name = d.getName();
    bool wanted = pending < 0 || name == "Click-" + String(records[pending].peerDevice);
    if (wanted && d.haveServiceUUID() && d.isAdvertisingService(BLEUUID(SERVICE_UUID)) &&
        d.getRSSI() >= RSSI_THRESHOLD && d.getRSSI() > strongest) { best = i; strongest = d.getRSSI(); }
  }
  String result = "ERR|NO_NEARBY_BRACELET";
  if (best >= 0 && !incomingConnected) {
    BLEAdvertisedDevice target = found->getDevice(best);
    Serial.printf("Candidate %s RSSI=%d\n", target.getName().c_str(), strongest);
    if (client->connectTimeout(&target, 5000)) {
      BLERemoteService *svc = client->getService(SERVICE_UUID);
      auto control = svc ? svc->getCharacteristic(CONTROL_UUID) : nullptr;
      auto status = svc ? svc->getCharacteristic(STATUS_UUID) : nullptr;
      auto data = svc ? svc->getCharacteristic(DATA_UUID) : nullptr;
      if (control && status && data) {
        result = peerCommand(control, status, data, "INFO");
        if (result.startsWith("OK|INFO|1|")) {
          String peerDev = field(result, 3), peerId = field(result, 4);
          if (!hexToken(peerDev, 12) || !token(peerId, 64) || peerId == userId || peerDev == deviceId) result = "ERR|SELF_OR_BAD_ID";
          else if (pending >= 0 && (peerDev != records[pending].peerDevice || peerId != records[pending].peerId)) result = "ERR|IDENTITY_CHANGED";
          else {
            int slot = pending >= 0 ? pending : freeSlot();
            if (slot < 0) result = "ERR|FULL";
            else {
              Record r = pending >= 0 ? records[slot] : makeRecord(randomHex(4), peerId, peerDev, REC_PENDING);
              if (pending < 0 && !saveRecord(slot, r)) result = "ERR|STORAGE";
              else {
                result = peerCommand(control, status, data, "OFFER|" + String(r.eventId) + "|" + userId + "|" + deviceId + "|" + peerId);
                if (result == "OK|SAVED|" + String(r.eventId)) {
                  r.state = CONFIRMED;
                  if (saveRecord(slot, r)) { success(peerId); result = "OK"; }
                  else result = "ERR|STORAGE";
                }
              }
            }
          }
        }
      } else result = "ERR|WRONG_FIRMWARE";
      client->disconnect();
    } else result = "ERR|CONNECT";
  }
  scanner->clearResults(); outbound = false;
  if (!incomingConnected) BLEDevice::startAdvertising();
  if (result != "OK") { show("EXCHANGE NOT CONFIRMED", result); readyAt = millis() + 3500; }
  nextTapAt = millis() + 3000;
}
static void setupBracelet() {
  Serial.begin(115200); pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(FEEDBACK_PIN, OUTPUT); digitalWrite(FEEDBACK_PIN, LOW);
  transportLock = xSemaphoreCreateMutex();
  if (!transportLock) { show("NO MEMORY"); while (true) delay(1000); }
  uint64_t mac = ESP.getEfuseMac(); char id[13];
  snprintf(id, sizeof(id), "%012llx", (unsigned long long)(mac & 0xffffffffffffULL));
  deviceId = id; bootId = randomHex(2);
  storageOK = prefs.begin("click_v1", false);
  userId = prefs.getString("my_id", "USER_202");
  if (!token(userId, 64)) storageOK = false;
  for (int i = 0; i < RECORD_CAPACITY; ++i) {
    String key = "r" + String(i);
    if (!prefs.isKey(key.c_str())) continue;
    if (prefs.getBytesLength(key.c_str()) != sizeof(Record) ||
        prefs.getBytes(key.c_str(), &records[i], sizeof(Record)) != sizeof(Record) ||
        records[i].version != RECORD_VERSION || records[i].state > SYNCED ||
        records[i].eventId[32] || records[i].ownerId[64] || records[i].peerId[64] ||
        records[i].peerDevice[12] || records[i].bootId[16]) {
      storageOK = false; memset(&records[i], 0, sizeof(Record));
    }
  }
  if (!BLEDevice::init("Click-" + deviceId)) { show("BLE INIT FAILED"); while (true) delay(1000); }
  server = BLEDevice::createServer(); server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(BLEUUID(SERVICE_UUID), 16);
  identityChar = svc->createCharacteristic(ID_UUID, BLECharacteristic::PROPERTY_READ);
  identityChar->setValue(userId);
  auto control = svc->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  auto status = svc->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ);
  auto data = svc->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_READ);
  control->setCallbacks(new ControlCallbacks()); status->setCallbacks(new StatusCallbacks()); data->setCallbacks(new DataCallbacks());
  svc->start();
  auto advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID); advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  BLEDevice::getScan()->setActiveScan(true);
  client = BLEDevice::createClient();
  Serial.println("Advertising: Click-" + deviceId + " | firmware 1 / protocol 1");
  Serial.println("Serial commands: t=tap, i=info. Disconnect browser before tapping.");
  ready();
}
static void loopBracelet() {
  serviceCommand();
  if (restartAdvertising && !outbound && !incomingConnected) { restartAdvertising = false; BLEDevice::startAdvertising(); }
  if (feedbackUntil && (int32_t)(millis() - feedbackUntil) >= 0) { digitalWrite(FEEDBACK_PIN, LOW); feedbackUntil = 0; }
  if (readyAt && (int32_t)(millis() - readyAt) >= 0) { readyAt = 0; ready(); }
  static int lastRaw = HIGH, stable = HIGH; static uint32_t changedAt = 0;
  int raw = digitalRead(BUTTON_PIN);
  if (raw != lastRaw) { lastRaw = raw; changedAt = millis(); }
  bool tap = false;
  if (raw != stable && millis() - changedAt >= 40) { stable = raw; tap = stable == LOW; }
  if (Serial.available()) { char c = Serial.read(); if (c == 't') tap = true; if (c == 'i') Serial.println(info()); }
  if (tap && (int32_t)(millis() - nextTapAt) >= 0) exchange();
  delay(5);
}

void setup() { setupBracelet(); }
void loop() { loopBracelet(); }
