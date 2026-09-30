// Ponte BLE GATT para o Imago instalado como PWA.
// O navegador atua como central BLE e o PC anuncia este serviço customizado.
// A dependencia e opcional: se o adaptador/driver nao suportar BLE periferico,
// o Imago continua funcionando por Wi-Fi, relay ou APK.

const SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const COMMAND_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214';
const EVENT_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214';
const MAX_COMMAND_BYTES = 4096;
const WEB_SAFE_EVENTS = new Set(['hello-ok', 'slide-info', 'thumbs-status', 'office-state', 'pc-disconnected']);

let bleno;
try {
  bleno = require('@stoprocent/bleno');
} catch {
  bleno = null;
}

function start({ token, onMessage, onConnect, log = console.log } = {}) {
  if (!bleno) {
    log('[BLE web] Ponte BLE indisponivel (dependencia opcional nao instalada).');
    return { available: false, broadcast() {} };
  }

  const authorized = new Set();
  const subscribers = new Map();
  let started = false;

  const eventCharacteristic = new bleno.Characteristic({
    uuid: EVENT_UUID,
    properties: ['read', 'notify'],
    onReadRequest(handle, offset, callback) {
      const value = Buffer.from('Imago Web Bluetooth 1', 'utf8');
      if (offset >= value.length) return callback(bleno.Characteristic.RESULT_INVALID_OFFSET);
      callback(bleno.Characteristic.RESULT_SUCCESS, value.slice(offset));
    },
    onSubscribe(handle, maxValueSize, updateValueCallback) {
      subscribers.set(handle, { maxValueSize, updateValueCallback });
      if (authorized.has(handle)) onConnect?.();
    },
    onUnsubscribe(handle) {
      subscribers.delete(handle);
      authorized.delete(handle);
    },
  });

  const commandCharacteristic = new bleno.Characteristic({
    uuid: COMMAND_UUID,
    properties: ['write', 'writeWithoutResponse'],
    onWriteRequest(handle, data, offset, withoutResponse, callback) {
      if (offset !== 0 || data.length > MAX_COMMAND_BYTES) {
        callback(bleno.Characteristic.RESULT_INVALID_ATTRIBUTE_LENGTH);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch {
        callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR);
        return;
      }
      if (!msg || typeof msg !== 'object') {
        callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR);
        return;
      }
      if (!authorized.has(handle)) {
        if (msg.type !== 'hello' || String(msg.token || '') !== String(token || '')) {
          callback(bleno.Characteristic.RESULT_UNLIKELY_ERROR);
          try { bleno.disconnect(handle); } catch { /* ja desconectado */ }
          return;
        }
        authorized.add(handle);
        sendTo(handle, { type: 'hello-ok' });
        onConnect?.();
        callback(bleno.Characteristic.RESULT_SUCCESS);
        return;
      }
      if (msg.type === 'hello') {
        callback(bleno.Characteristic.RESULT_SUCCESS);
        return;
      }
      onMessage?.(msg);
      callback(bleno.Characteristic.RESULT_SUCCESS);
    },
  });

  function sendTo(handle, payload) {
    const sub = subscribers.get(handle);
    if (!sub || !authorized.has(handle)) return;
    const data = Buffer.from(JSON.stringify(payload) + '\n', 'utf8');
    const max = Math.max(20, sub.maxValueSize || 20);
    for (let offset = 0; offset < data.length; offset += max) {
      sub.updateValueCallback(data.slice(offset, offset + max));
    }
  }

  function broadcast(payload) {
    if (!WEB_SAFE_EVENTS.has(payload?.type)) return;
    for (const handle of subscribers.keys()) sendTo(handle, payload);
  }

  const service = new bleno.PrimaryService({
    uuid: SERVICE_UUID,
    characteristics: [commandCharacteristic, eventCharacteristic],
  });

  const advertise = () => {
    if (started || bleno.state !== 'poweredOn') return;
    bleno.setServices([service], (serviceError) => {
      if (serviceError) { log(`[BLE web] Falha ao registrar servico: ${serviceError.message}`); return; }
      bleno.startAdvertising('Imago Web', [SERVICE_UUID], (error) => {
        if (error) log(`[BLE web] Falha ao anunciar: ${error.message}`);
        else { started = true; log('[BLE web] Pronto: abra o Imago instalado e toque em Conectar Bluetooth web.'); }
      });
    });
  };

  bleno.on('stateChange', (state) => {
    if (state === 'poweredOn') advertise();
    else if (started) { started = false; try { bleno.stopAdvertising(); } catch { /* ignora */ } }
  });
  bleno.on('disconnect', (handle) => { subscribers.delete(handle); authorized.delete(handle); });
  advertise();
  return { available: true, broadcast };
}

module.exports = { SERVICE_UUID, COMMAND_UUID, EVENT_UUID, start };
