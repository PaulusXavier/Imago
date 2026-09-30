// IMPORTANTE: coloque aqui a URL do SEU relay publicado (ex: no Render),
// a mesma usada em controller.js na variavel RELAY_URL.
const RELAY_URL = 'wss://SEU-RELAY.onrender.com';

// ---- Bluetooth (só existe no app Android/APK) ----
// Declarado no topo para que send()/showControlScreen() possam usar sem risco.
const isApk = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const BtHid = isApk ? window.Capacitor.registerPlugin('ImagoHid') : null;
let btMode = false;
let laserSens = 2.2;
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}

// localStorage pode lançar exceção (modo privado, cookies bloqueados, cota cheia).
// Como é lido logo no início do arquivo, sem proteção o app inteiro deixava de abrir.
function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* segue sem salvar */ }
}

const LOCAL_CONNECT_TIMEOUT_MS = 2500;
const STORAGE_KEY = 'imago-last-connection';
const MAX_RECONNECT_ATTEMPTS = 6;

const THUMBS_REASON_LABELS = {
  'ferramentas-ausentes': 'Miniaturas indisponíveis (instale o LibreOffice e o Poppler no PC).',
  'erro-soffice': 'Miniaturas indisponíveis (falha ao converter o .pptx no PC).',
  'erro-pdftoppm': 'Miniaturas indisponíveis (falha ao gerar as imagens no PC).',
  'nenhuma-imagem-gerada': 'Miniaturas indisponíveis (nenhuma imagem foi gerada).',
  'sem-slides': 'Configure o PPTX_PATH no PC para ver as miniaturas.',
  'erro-cache': 'Miniaturas indisponíveis (erro de cache no PC).',
};

const els = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  connectScreen: document.getElementById('connect-screen'),
  controlScreen: document.getElementById('control-screen'),
  reconnectBanner: document.getElementById('reconnect-banner'),
  slideInfo: document.getElementById('slide-info'),
  slideCounter: document.getElementById('slide-counter'),
  slideTitle: document.getElementById('slide-title'),
  slideNotes: document.getElementById('slide-notes'),
  inputIp: document.getElementById('input-ip'),
  inputPort: document.getElementById('input-port'),
  inputCode: document.getElementById('input-code'),
  inputToken: document.getElementById('input-token'),
  networkStatus: document.getElementById('network-status'),
  webBleCard: document.getElementById('web-ble-card'),
  webBleButton: document.getElementById('btn-web-ble'),
  webBleMessage: document.getElementById('web-ble-message'),
  btnConnect: document.getElementById('btn-connect'),
  btnDisconnect: document.getElementById('btn-disconnect'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnBlack: document.getElementById('btn-black'),
  btnStart: document.getElementById('btn-start'),
  btnEnd: document.getElementById('btn-end'),
  tabSlides: document.getElementById('tab-slides'),
  tabThumbs: document.getElementById('tab-thumbs'),
  tabLaser: document.getElementById('tab-laser'),
  tabHistory: document.getElementById('tab-history'),
  tabOffice: document.getElementById('tab-office'),
  officePanel: document.getElementById('office-panel'),
  slidesPanel: document.getElementById('slides-panel'),
  thumbsPanel: document.getElementById('thumbs-panel'),
  thumbsStatus: document.getElementById('thumbs-status'),
  thumbsGrid: document.getElementById('thumbs-grid'),
  laserPanel: document.getElementById('laser-panel'),
  historyPanel: document.getElementById('history-panel'),
  historyEmpty: document.getElementById('history-empty'),
  historyList: document.getElementById('history-list'),
  touchpad: document.getElementById('touchpad'),
  timer: document.getElementById('timer'),
  notes: document.getElementById('notes'),
  btnInstall: document.getElementById('btn-install'),
  installedHint: document.getElementById('installed-hint'),
};

let socket = null;
let webBleDevice = null;
let webBleCommand = null;
let webBleMode = false;
let timerInterval = null;
let timerSeconds = 0;
let wakeLock = null;
let userInitiatedDisconnect = false;
let reconnectAttempts = 0;
let lastConnectionParams = null; // { ip, port, code, token }
let networkMode = storageGet('imago-network-mode') || 'auto';
let connectionTransport = null;
// Codigo de seguranca do Imago atual -- vem do QR/link (?token=...) ou de
// uma conexao anterior salva. Sem o token certo, o PC recusa a conexao (ver
// controller.js): assim, so quem escaneou o QR (ou digitou o codigo que
// aparece na tela do PC) consegue controlar a apresentacao.
let sessionToken = '';
let isReconnecting = false;
let activeTab = 'slides';
let currentSlideIndex = null;
let currentSlideTotal = null;
let thumbItems = new Map(); // index -> { wrapper, img }
let officeState = null;
let officeSlidesList = [];

// ---------- Vibração tátil ----------
function vibrate(ms = 15) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------- Instalar como app na tela inicial ----------
// Faz o Imago se comportar como um "app instalado de verdade" (ícone na
// tela inicial, abre em tela cheia sem barra do navegador), o mais parecido
// possível com instalar o app do Office Remote no celular -- só que sem
// precisar de loja de aplicativos.
let deferredInstallPrompt = null;
const isStandalone =
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (isStandalone) {
  els.installedHint?.classList.remove('hidden');
} else {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.btnInstall?.classList.remove('hidden');
  });
  els.btnInstall?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      toast(
        'Pra instalar: toque no menu do navegador (⋮ ou compartilhar) e escolha "Adicionar à tela inicial" / "Instalar app".'
      );
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.btnInstall?.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    els.btnInstall?.classList.add('hidden');
    els.installedHint?.classList.remove('hidden');
  });
}

// ---------- Wake Lock (impede a tela de apagar durante a apresentação) ----------
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // se falhar, a apresentação continua funcionando normalmente
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (socket && !els.controlScreen.classList.contains('hidden')) {
    acquireWakeLock();
    if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
      attemptAutoReconnect();
    }
  }
});

// ---------- Lembrar a última conexão ----------
function saveLastConnection(params) {
  storageSet(STORAGE_KEY, JSON.stringify(params));
}
function loadLastConnection() {
  try {
    return JSON.parse(storageGet(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function setStatus(connected, text) {
  els.statusDot.classList.toggle('connected', connected);
  els.statusText.textContent = text;
  const transportChip = document.getElementById('transport-chip');
  if (transportChip) transportChip.textContent = text;
  document.getElementById('status-bar')?.setAttribute('aria-label', `Status: ${text}`);
}

function showControlScreen() {
  els.connectScreen.classList.add('hidden');
  els.controlScreen.classList.remove('hidden');
  els.reconnectBanner.classList.add('hidden');
  startTimer();
  acquireWakeLock();
  volumeKeysApply();
}

function showConnectScreen() {
  els.controlScreen.classList.add('hidden');
  els.connectScreen.classList.remove('hidden');
  stopTimer();
  releaseWakeLock();
  volumeKeysApply();
  resetThumbsGrid();
  officeState = null;
  officeSlidesList = [];
  currentSlideIndex = null;
  currentSlideTotal = null;
  setActiveTab('slides', { silent: true });
}

let timerPaused = false;
function startTimer() {
  clearInterval(timerInterval);
  timerSeconds = 0;
  timerPaused = false;
  els.timer.classList.remove('paused');
  updateTimerDisplay();
  let last = Date.now();
  timerInterval = setInterval(() => {
    const d = Math.floor((Date.now() - last) / 1000);
    if (d < 1) return;
    last += d * 1000;
    if (timerPaused) return;
    timerSeconds += d;
    updateTimerDisplay();
  }, 500);
}
function stopTimer() {
  clearInterval(timerInterval);
}
// Toque no cronômetro: pausa/continua. Duplo toque: zera.
let timerTapTimeout = null;
els.timer.addEventListener('click', () => {
  if (timerTapTimeout) {
    clearTimeout(timerTapTimeout);
    timerTapTimeout = null;
    timerSeconds = 0;
    updateTimerDisplay();
    vibrate(30);
    return;
  }
  timerTapTimeout = setTimeout(() => {
    timerTapTimeout = null;
    timerPaused = !timerPaused;
    els.timer.classList.toggle('paused', timerPaused);
  }, 260);
});
function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  els.timer.textContent = `${m}:${s}`;
}

// Cada toque do dedo gerava uma mensagem; pelo relay/BLE isso enfileirava e atrasava o cursor.
// Aqui os movimentos são somados e enviados no máximo ~60x/s (o modo Bluetooth já fazia isso).
let moveAcc = { dx: 0, dy: 0 };
let moveTimer = null;
function queueMove(payload) {
  moveAcc.dx += payload.dx;
  moveAcc.dy += payload.dy;
  if (moveTimer) return;
  moveTimer = setTimeout(() => {
    moveTimer = null;
    const { dx, dy } = moveAcc;
    moveAcc = { dx: 0, dy: 0 };
    if (dx || dy) sendNow({ type: 'move', dx, dy });
  }, 16);
}

function send(payload) {
  if (btMode) return btSend(payload);
  if (payload.type === 'move') { queueMove(payload); return; }
  sendNow(payload);
}
function sendNow(payload) {
  if (webBleMode) { webBleSend(payload).catch(() => {}); return; }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (payload.type === 'command') toast('Sem conexão com o PC. Aguarde a reconexão ou conecte de novo.');
    return;
  }
  socket.send(JSON.stringify(payload));
}
function sendCommand(command, extra) {
  vibrate();
  send({ type: 'command', command, ...extra });
}

// ---------- Notas pessoais (do apresentador, guardadas no celular) ----------
// Antes a chave era so o numero do slide: as notas do "slide 3" de uma apresentacao
// apareciam no "slide 3" de qualquer outra. Agora a chave inclui o nome da apresentacao
// (o PC informa em slide-info.name). PCs antigos nao mandam o nome: ficam na chave antiga.
let currentDeckKey = '';
function deckKeyFrom(name) {
  return String(name || '').trim().toLowerCase().replace(/\.(pptx?|ppsx?)$/i, '').slice(0, 80);
}
function notesKey(index) {
  return currentDeckKey ? `imago-notes-d:${encodeURIComponent(currentDeckKey)}:${index}` : `imago-notes-${index}`;
}
// Notas escritas antes desta versao (chave so com o numero) passam para a primeira
// apresentacao aberta depois da atualizacao, em vez de sumirem.
function migrateLegacyNotes() {
  if (!currentDeckKey || storageGet('imago-notes-migrated') === '1') return;
  try {
    const legacy = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (/^imago-notes-\d+$/.test(k)) legacy.push(k);
    }
    for (const k of legacy) {
      const value = window.localStorage.getItem(k);
      const target = `imago-notes-d:${encodeURIComponent(currentDeckKey)}:${k.slice('imago-notes-'.length)}`;
      if (value && window.localStorage.getItem(target) === null) window.localStorage.setItem(target, value);
      window.localStorage.removeItem(k);
    }
  } catch { /* armazenamento indisponivel: tenta de novo na proxima vez */ return; }
  storageSet('imago-notes-migrated', '1');
}

// ---------- Conexão ----------
function updateSlideInfo(msg) {
  els.slideInfo.classList.remove('hidden');
  els.slideCounter.textContent = `Slide ${msg.index} de ${msg.total}`;
  els.slideTitle.textContent = msg.title || '';
  els.slideNotes.textContent = msg.notes || '';
  currentSlideIndex = msg.index;
  currentSlideTotal = msg.total;
  document.getElementById('slide-progress-bar').style.width = msg.total ? (msg.index / msg.total) * 100 + '%' : '0';
  currentDeckKey = deckKeyFrom(msg.name);
  migrateLegacyNotes();
  try { els.notes.value = storageGet(notesKey(msg.index)) || ''; } catch { /* ignora */ }
  highlightActiveThumb();
  updateNextPreview();
}

// ---------- Miniaturas dos slides ----------
function resetThumbsGrid() {
  thumbItems = new Map();
  els.thumbsGrid.innerHTML = '';
  els.thumbsStatus.textContent = '';
}

function buildThumbsSkeleton(total) {
  if (thumbItems.size === total) return; // já construída
  els.thumbsGrid.innerHTML = '';
  thumbItems = new Map();
  for (let i = 1; i <= total; i++) {
    const wrapper = document.createElement('button');
    wrapper.className = 'thumb-item skeleton';
    wrapper.type = 'button';
    wrapper.setAttribute('aria-label', `Ir para o slide ${i}`);

    const img = document.createElement('img');
    img.alt = `Slide ${i}`;
    img.hidden = true;

    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = String(i);

    wrapper.appendChild(img);
    wrapper.appendChild(label);
    wrapper.addEventListener('click', () => sendCommand('goto', { index: i }));

    els.thumbsGrid.appendChild(wrapper);
    thumbItems.set(i, { wrapper, img });
  }
  highlightActiveThumb();
}

function setThumbImage(index, dataUrl) {
  const item = thumbItems.get(index);
  if (!item) return;
  // So imagem embutida (data:image/png|jpeg;base64): nada de apontar o <img> para outro endereco.
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return;
  item.img.src = dataUrl;
  item.img.hidden = false;
  item.wrapper.classList.remove('skeleton');
  updateNextPreview();
}

function highlightActiveThumb() {
  thumbItems.forEach((item, index) => {
    item.wrapper.classList.toggle('current', index === currentSlideIndex);
  });
}

function handleThumbsStatus(msg) {
  if (msg.available) {
    buildThumbsSkeleton(msg.total);
    els.thumbsStatus.textContent = msg.generating ? 'Gerando miniaturas…' : '';
  } else {
    resetThumbsGrid();
    els.thumbsStatus.textContent =
      THUMBS_REASON_LABELS[msg.reason] || 'Miniaturas indisponíveis no momento.';
  }
}

function handleSlideThumb(msg) {
  if (thumbItems.size !== msg.total) buildThumbsSkeleton(msg.total);
  setThumbImage(msg.index, msg.dataUrl);
}

// ---------- Histórico de sessões ----------
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} min ${s}s` : `${s}s`;
}
function formatDate(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderHistory(sessions) {
  els.historyList.innerHTML = '';
  els.historyEmpty.classList.toggle('hidden', sessions.length > 0);
  sessions.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const top = document.createElement('div');
    top.className = 'history-item-top';
    top.textContent = formatDate(s.startedAt);

    const bottom = document.createElement('div');
    bottom.className = 'history-item-bottom';
    const slidesInfo = s.slidesTotal ? `slides até ${s.maxSlideReached}/${s.slidesTotal}` : 'sem slides sincronizados';
    bottom.textContent = `${formatDuration(s.durationSec)} · ${slidesInfo}`;

    item.appendChild(top);
    item.appendChild(bottom);
    if (s.pptxName) {
      const name = document.createElement('div');
      name.className = 'history-item-file';
      name.textContent = s.pptxName;
      item.appendChild(name);
    }
    els.historyList.appendChild(item);
  });
}

function requestHistory() {
  send({ type: 'get-history' });
}

function wireIncomingMessages(ws) {
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleIncomingPayload(msg);
  });
}

function handleIncomingPayload(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'slide-info') updateSlideInfo(msg);
    else if (msg.type === 'thumbs-status') handleThumbsStatus(msg);
    else if (msg.type === 'slide-thumb') handleSlideThumb(msg);
    else if (msg.type === 'history') renderHistory(msg.sessions || []);
    else if (msg.type === 'office-state') handleOfficeState(msg);
    else if (msg.type === 'office-slides') handleOfficeSlides(msg);
}

function wireSocketLifecycle(ws) {
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (userInitiatedDisconnect) {
      setStatus(false, 'Desconectado');
      showConnectScreen();
      return;
    }
    // Conexao caiu sem o usuario pedir: tenta reconectar automaticamente
    attemptAutoReconnect();
  });
}

const WEB_BLE_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
const WEB_BLE_COMMAND_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214';
const WEB_BLE_EVENT_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214';
let webBleHelloResolve = null;
let webBleRxBuffer = '';
let webBleDecoder = null; // criado sob demanda (so o Web Bluetooth usa)

function setWebBleMessage(text) {
  if (els.webBleMessage) els.webBleMessage.textContent = text;
}

async function webBleSend(payload) {
  if (!webBleCommand) return;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (webBleCommand.writeValueWithResponse) await webBleCommand.writeValueWithResponse(bytes);
  else await webBleCommand.writeValue(bytes);
}

function handleWebBleNotification(event) {
  // stream:true guarda os bytes soltos de um caractere multibyte (ã, é, ç...) até o próximo pacote.
  if (!webBleDecoder) webBleDecoder = new TextDecoder();
  webBleRxBuffer += webBleDecoder.decode(event.target.value, { stream: true });
  const lines = webBleRxBuffer.split('\n');
  webBleRxBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'hello-ok') webBleHelloResolve?.();
      handleIncomingPayload(msg);
    } catch { /* aguarda a próxima notificação se o pacote estiver incompleto */ }
  }
}

function handleWebBleDisconnected() {
  webBleMode = false;
  webBleCommand = null;
  setWebBleMessage('Bluetooth web desconectado. Toque novamente para escolher o PC.');
  if (!els.controlScreen.classList.contains('hidden')) {
    setStatus(false, 'Bluetooth web desconectado');
    showConnectScreen();
  }
}

async function connectWebBluetooth() {
  if (!navigator.bluetooth || !window.isSecureContext) {
    toast('Bluetooth web exige Chrome/Android e um endereço HTTPS.');
    return;
  }
  els.webBleButton.disabled = true;
  els.webBleButton.textContent = 'Escolha o Imago no PC…';
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [WEB_BLE_SERVICE_UUID] }],
      optionalServices: [WEB_BLE_SERVICE_UUID],
    });
    webBleDevice = device;
    device.addEventListener('gattserverdisconnected', handleWebBleDisconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(WEB_BLE_SERVICE_UUID);
    webBleCommand = await service.getCharacteristic(WEB_BLE_COMMAND_UUID);
    const events = await service.getCharacteristic(WEB_BLE_EVENT_UUID);
    await events.startNotifications();
    events.addEventListener('characteristicvaluechanged', handleWebBleNotification);
    webBleRxBuffer = '';
    webBleDecoder = null;
    await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('web-ble-auth-timeout')), 6000);
      webBleHelloResolve = () => { clearTimeout(timer); resolve(); };
      try { await webBleSend({ type: 'hello', token: sessionToken }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
    webBleHelloResolve = null;
    webBleMode = true;
    userInitiatedDisconnect = false;
    connectionTransport = 'bluetooth-web';
    setStatus(true, 'Conectado (Bluetooth web)');
    setWebBleMessage(`Conectado ao ${device.name || 'Imago no PC'}.`);
    showControlScreen();
  } catch (error) {
    webBleMode = false;
    webBleCommand = null;
    webBleHelloResolve = null;
    try {
      // Sem isso o PC continuava com um "celular" conectado que ninguém usava.
      // O listener sai antes para o aviso de "desconectado" não apagar a mensagem de erro.
      webBleDevice?.removeEventListener('gattserverdisconnected', handleWebBleDisconnected);
      webBleDevice?.gatt?.disconnect();
    } catch { /* já desconectado */ }
    const text = error?.message === 'web-ble-auth-timeout'
      ? 'O PC recusou a autenticação. Abra o QR code novamente e tente escolher o dispositivo certo.'
      : 'Não foi possível conectar. Use Chrome/Android, HTTPS e mantenha o Imago aberto no PC.';
    setWebBleMessage(text);
    toast(text);
  } finally {
    els.webBleButton.disabled = false;
    els.webBleButton.textContent = 'Conectar Bluetooth web';
  }
}

// Conecta e faz o "handshake" de autenticação: manda {type:'hello', token}
// assim que a conexão abre e só resolve a promise quando o PC confirma com
// {type:'hello-ok'}. Se o token estiver errado (ou faltando), o PC fecha a
// conexão sem confirmar -- por isso também tratamos o 'close' como falha.
async function connectLocal(ip, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${ip}:${port}`);
    let settled = false;

    const timeout = setTimeout(() => {
      settle(reject, new Error('timeout'));
      ws.close();
    }, LOCAL_CONNECT_TIMEOUT_MS);

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
      fn(value);
    }
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'hello-ok') settle(resolve, ws);
    }
    function onClose() {
      settle(reject, new Error('auth-failed'));
    }
    function onError() {
      settle(reject, new Error('local-failed'));
    }

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: sessionToken })));
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
  });
}

const RELAY_HELLO_TIMEOUT_MS = 6000;
// Tempo total para achar o relay + entrar na sessao. Generoso de proposito: o
// plano gratis do Render "dorme" e leva ate ~1 min para acordar.
const RELAY_CONNECT_TIMEOUT_MS = 60000;
const RELAY_NOT_CONFIGURED = /SEU-RELAY/i.test(RELAY_URL);

async function connectRelay(code) {
  if (RELAY_NOT_CONFIGURED) throw new Error('relay-not-configured');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    let settled = false;
    let helloTimeout = null;
    const overallTimeout = setTimeout(() => settle(reject, new Error('relay-timeout')), RELAY_CONNECT_TIMEOUT_MS);

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(helloTimeout);
      clearTimeout(overallTimeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      // Em qualquer falha, fecha o socket: sem isso ele ficava aberto no relay
      // (gastando o limite de conexoes por minuto a cada tentativa).
      if (fn === reject) {
        try { ws.close(); } catch { /* ja fechado */ }
      }
      fn(value);
    }
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignora mensagem invalida em vez de derrubar a conexao
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'joined') {
        // Entrou na sessão pelo código -- ainda falta provar que também
        // tem o codigo de seguranca (token) antes do PC liberar comandos.
        ws.send(JSON.stringify({ type: 'hello', token: sessionToken }));
        helloTimeout = setTimeout(() => settle(reject, new Error('auth-failed')), RELAY_HELLO_TIMEOUT_MS);
        return;
      }
      if (msg.type === 'hello-ok') {
        settle(resolve, ws);
        return;
      }
      if (msg.type === 'error') {
        settle(reject, new Error(msg.message));
        return;
      }
      // 'pc-disconnected': o servidor ja fecha esta conexao logo em seguida.
      if (msg.type === 'pc-disconnected') settle(reject, new Error('pc-disconnected'));
    }
    function onError() {
      settle(reject, new Error('relay-failed'));
    }
    // Se o relay fechar a conexao sem erro (ex.: limite de conexoes), antes
    // a tela ficava presa em "Conectando..." para sempre.
    function onClose() {
      settle(reject, new Error('relay-failed'));
    }

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', code })));
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

async function tryConnect({ ip, port, code }) {
  if (networkMode !== 'internet' && ip) {
    try {
      return await connectLocal(ip, port || '8765');
    } catch (err) {
      // Codigo de seguranca errado vale para qualquer caminho: tentar o relay so atrasa.
      if (err && err.message === 'auth-failed') throw err;
      if (networkMode === 'wifi') throw new Error('wifi-failed');
      /* no modo automático, cai para o relay */
    }
  }
  if (networkMode !== 'wifi' && code) {
    return await connectRelay(code);
  }
  throw new Error(networkMode === 'wifi' ? 'wifi-data-missing' : 'internet-data-missing');
}

function setNetworkMode(mode) {
  networkMode = ['auto', 'wifi', 'internet'].includes(mode) ? mode : 'auto';
  storageSet('imago-network-mode', networkMode);
  document.querySelectorAll('[data-network-mode]').forEach((button) => {
    const active = button.dataset.networkMode === networkMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const descriptions = {
    auto: 'Automático: tenta Wi-Fi primeiro e usa a internet como reserva.',
    wifi: 'Wi-Fi: conexão direta, mais rápida e funciona sem internet.',
    internet: 'Dados móveis: usa o relay; deixe o código de 6 dígitos preenchido.',
  };
  if (els.networkStatus) els.networkStatus.textContent = descriptions[networkMode];
}

async function handleConnect() {
  if (els.inputToken?.value.trim()) sessionToken = els.inputToken.value.trim().toUpperCase();
  const invalid = validateConnectForm();
  if (invalid) { showFormError(invalid[0], invalid[1]); invalid[1][0]?.focus(); return; }
  showFormError('');
  const params = {
    ip: els.inputIp.value.trim(),
    port: els.inputPort.value.trim() || '8765',
    code: els.inputCode.value.trim(),
    token: sessionToken,
  };
  setStatus(false, 'Conectando...');
  els.btnConnect.disabled = true;
  els.btnConnect.textContent = 'Conectando';

  try {
    const ws = await tryConnect(params);
    socket = ws;
    connectionTransport = ws.url?.startsWith('ws://') ? 'wifi' : 'internet';
    userInitiatedDisconnect = false;
    reconnectAttempts = 0;
    lastConnectionParams = params;
    saveLastConnection(params);
    // O token nao precisa ficar visivel na barra de enderecos / historico.
    try { if (location.search) history.replaceState(null, '', location.pathname); } catch { /* ignora */ }
    wireSocketLifecycle(ws);
    wireIncomingMessages(ws);
    setStatus(true, connectionTransport === 'wifi' ? 'Conectado (Wi-Fi local)' : 'Conectado (dados móveis/internet)');
    showControlScreen();
  } catch (err) {
    setStatus(false, 'Falha ao conectar');
    if (err.message === 'auth-failed') {
      toast('Código de segurança incorreto ou ausente. Escaneie o QR code de novo (ele muda toda vez que o Imago abre).');
    } else if (err.message === 'relay-not-configured') {
      toast('O relay (internet) ainda não foi configurado neste app: falta trocar RELAY_URL no app.js. Use o IP da rede local ou o modo Bluetooth.');
    } else if (err.message === 'relay-timeout') {
      toast('O relay demorou demais para responder. Se ele estiver no plano gratuito do Render, pode estar acordando: tente de novo em 1 minuto.');
    } else if (err.message === 'wifi-failed') {
      toast('Não encontrei o PC no Wi-Fi. Confira se celular e PC estão na mesma rede ou escolha Dados móveis.');
    } else if (err.message === 'wifi-data-missing') {
      toast('Para usar Wi-Fi, informe o IP local e a porta do PC.');
    } else if (err.message === 'internet-data-missing') {
      toast('Para usar dados móveis, informe o código de 6 dígitos do relay.');
    } else {
      toast('Não foi possível conectar: informe o IP local ou o código do relay.');
    }
  } finally {
    els.btnConnect.disabled = false;
    els.btnConnect.textContent = 'Conectar';
  }
}

async function attemptAutoReconnect() {
  if (isReconnecting) return;
  if (!lastConnectionParams || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setStatus(false, 'Desconectado');
    showConnectScreen();
    return;
  }
  isReconnecting = true;
  reconnectAttempts++;
  const params = lastConnectionParams;
  // O banner também é usado pelo modo Bluetooth com outro texto; restaura o padrão.
  els.reconnectBanner.textContent = 'Reconectando…';
  els.reconnectBanner.classList.remove('hidden');
  setStatus(false, `Reconectando... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  const delay = Math.min(1000 * reconnectAttempts, 5000);
  await new Promise((r) => setTimeout(r, delay));
  // Tocou em Desconectar enquanto esperava? Então não reconecta.
  if (userInitiatedDisconnect) { isReconnecting = false; return; }

  try {
    const ws = await tryConnect(params);
    if (userInitiatedDisconnect) {
      // Desconectou durante a tentativa: fecha a conexão que acabou de abrir em vez de
      // deixá-la ativa no PC com a tela de conexão aberta no celular.
      try { ws.close(); } catch { /* ignora */ }
      isReconnecting = false;
      return;
    }
    socket = ws;
    connectionTransport = ws.url?.startsWith('ws://') ? 'wifi' : 'internet';
    reconnectAttempts = 0;
    wireSocketLifecycle(ws);
    wireIncomingMessages(ws);
    els.reconnectBanner.classList.add('hidden');
    setStatus(true, connectionTransport === 'wifi' ? 'Reconectado (Wi-Fi local)' : 'Reconectado (dados móveis/internet)');
    isReconnecting = false;
  } catch (err) {
    isReconnecting = false;
    if (err && err.message === 'auth-failed') {
      // O Imago do PC foi fechado e reaberto: o codigo de seguranca mudou.
      toast('O Imago do PC foi reiniciado (o código de segurança mudou). Escaneie o QR code de novo.');
      setStatus(false, 'Desconectado');
      showConnectScreen();
      return;
    }
    attemptAutoReconnect();
  }
}

function handleDisconnect() {
  // Sai da aba Laser antes de fechar: senão o laser ficava ligado no PowerPoint.
  if (activeTab === 'laser') send({ type: 'command', command: 'laser-off' });
  userInitiatedDisconnect = true;
  if (btMode) btLeave();
  if (webBleMode) {
    webBleMode = false;
    webBleCommand = null;
    try { webBleDevice?.gatt?.disconnect(); } catch { /* já desconectado */ }
  }
  socket?.close();
  socket = null;
  lastConnectionParams = null;
  showConnectScreen();
  setStatus(false, 'Desconectado');
}

// ---------- Abas: Slides / Miniaturas / Laser / Histórico ----------
const TABS = {
  slides: { tab: 'tabSlides', panel: 'slidesPanel' },
  thumbs: { tab: 'tabThumbs', panel: 'thumbsPanel' },
  laser: { tab: 'tabLaser', panel: 'laserPanel' },
  office: { tab: 'tabOffice', panel: 'officePanel' },
  history: { tab: 'tabHistory', panel: 'historyPanel' },
};

function setActiveTab(name, { silent } = {}) {
  const wasLaser = activeTab === 'laser';
  activeTab = name;
  Object.entries(TABS).forEach(([key, refs]) => {
    els[refs.tab].classList.toggle('active', key === name);
    els[refs.tab].setAttribute('aria-selected', key === name ? 'true' : 'false');
    els[refs.panel].classList.toggle('hidden', key !== name);
  });

  if (!silent) {
    if (wasLaser && name !== 'laser') send({ type: 'command', command: 'laser-off' });
    if (!wasLaser && name === 'laser') send({ type: 'command', command: 'laser-on' });
    if (name === 'history') requestHistory();
  }
}

// ---------- Touchpad (apontador laser) ----------
let touchLast = null;
let touchStartInfo = null;
function onTouchStart(e) {
  const t = e.touches[0];
  touchLast = { x: t.clientX, y: t.clientY };
  touchStartInfo = { x: t.clientX, y: t.clientY, time: Date.now(), moved: 0 };
  els.touchpad.classList.add('dragging');
}
function onTouchMove(e) {
  e.preventDefault();
  if (!touchLast) return;
  const t = e.touches[0];
  const dx = (t.clientX - touchLast.x) * laserSens;
  const dy = (t.clientY - touchLast.y) * laserSens;
  if (touchStartInfo) touchStartInfo.moved += Math.abs(t.clientX - touchLast.x) + Math.abs(t.clientY - touchLast.y);
  touchLast = { x: t.clientX, y: t.clientY };
  send({ type: 'move', dx, dy });
}
function onTouchEnd() {
  // Toque rápido e parado = clique do mouse (útil no Prezi e para abrir links/vídeos).
  if (touchStartInfo && touchStartInfo.moved < 8 && Date.now() - touchStartInfo.time < 250) {
    vibrate(10);
    send({ type: 'click' });
  }
  touchStartInfo = null;
  touchLast = null;
  els.touchpad.classList.remove('dragging');
}

// ---------- Gesto de arrastar para trocar slide ----------
let slideSwipeStartX = null;
let slideSwipeStartY = 0;
function onSlideTouchStart(e) {
  slideSwipeStartX = e.touches[0].clientX;
  slideSwipeStartY = e.touches[0].clientY;
}
function onSlideTouchEnd(e) {
  if (slideSwipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - slideSwipeStartX;
  const dy = e.changedTouches[0].clientY - slideSwipeStartY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) sendCommand(dx < 0 ? 'next' : 'prev');
  slideSwipeStartX = null;
}

// Preenche campos automaticamente se vieram via QR code (?ip=&port=&code=)
function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const hasUrlParams = params.get('ip') || params.get('code');
  if (params.get('ip')) els.inputIp.value = params.get('ip');
  if (params.get('port')) els.inputPort.value = params.get('port');
  if (params.get('code')) els.inputCode.value = params.get('code');
  if (params.get('token')) {
    sessionToken = params.get('token');
    if (els.inputToken) els.inputToken.value = sessionToken;
  }
  return hasUrlParams;
}
function prefillFromStorage() {
  const last = loadLastConnection();
  if (!last) return;
  if (!els.inputIp.value) els.inputIp.value = last.ip || '';
  if (!els.inputPort.value) els.inputPort.value = last.port || '8765';
  if (!els.inputCode.value) els.inputCode.value = last.code || '';
  if (!sessionToken && last.token) {
    sessionToken = last.token;
    if (els.inputToken) els.inputToken.value = sessionToken;
  }
}

els.btnConnect.addEventListener('click', handleConnect);
els.btnDisconnect.addEventListener('click', handleDisconnect);
els.btnPrev.addEventListener('click', () => sendCommand('prev'));
els.btnNext.addEventListener('click', () => sendCommand('next'));
els.btnBlack.addEventListener('click', () => sendCommand('black'));
els.btnStart.addEventListener('click', () => sendCommand('start'));
document.getElementById('btn-start-current').addEventListener('click', () => sendCommand('start', { fromCurrent: true }));
els.btnEnd.addEventListener('click', () => sendCommand('end'));
els.tabSlides.addEventListener('click', () => setActiveTab('slides'));
els.tabThumbs.addEventListener('click', () => setActiveTab('thumbs'));
els.tabLaser.addEventListener('click', () => setActiveTab('laser'));
els.tabHistory.addEventListener('click', () => setActiveTab('history'));
els.tabOffice.addEventListener('click', () => setActiveTab('office'));

els.touchpad.addEventListener('touchstart', onTouchStart, { passive: true });
els.touchpad.addEventListener('touchmove', onTouchMove, { passive: false });
els.touchpad.addEventListener('touchend', onTouchEnd);

els.slidesPanel.addEventListener('touchstart', onSlideTouchStart, { passive: true });
els.slidesPanel.addEventListener('touchend', onSlideTouchEnd);

// ---------- Office (leitura real do PowerPoint / Word / Excel via ponte COM no PC) ----------
const $ = (id) => document.getElementById(id);
const APP_LABEL = { powerpoint: 'PowerPoint', word: 'Word', excel: 'Excel' };

function officeCmd(cmd, extra) {
  vibrate();
  send({ type: 'office', cmd, ...extra });
}

function updateNextPreview() {
  const box = $('next-preview');
  const total = officeState?.ppt?.total || currentSlideTotal;
  if (!total || !currentSlideIndex || currentSlideIndex >= total) {
    box.classList.add('hidden');
    return;
  }
  const next = currentSlideIndex + 1;
  box.classList.remove('hidden');
  const t = officeSlidesList.find((s) => s.i === next);
  $('next-preview-title').textContent = t ? `${next}. ${t.title}` : `Slide ${next}`;
  const item = thumbItems.get(next);
  const img = $('next-preview-img');
  if (item && !item.img.hidden) {
    img.src = item.img.src;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
}

function renderMedia(list) {
  const box = $('media-list');
  box.innerHTML = '';
  box.classList.toggle('hidden', !list || list.length === 0);
  (list || []).forEach((m) => {
    const row = document.createElement('div');
    row.className = 'office-row';
    const label = document.createElement('span');
    label.textContent = `${m.kind === 'audio' ? '🔊' : '🎬'} ${m.name}`;
    const play = document.createElement('button');
    play.className = 'small-btn';
    play.textContent = '▶';
    play.addEventListener('click', () => officeCmd('ppt.media', { name: m.name, pause: false }));
    const pause = document.createElement('button');
    pause.className = 'small-btn';
    pause.textContent = '⏸';
    pause.addEventListener('click', () => officeCmd('ppt.media', { name: m.name, pause: true }));
    row.append(label, play, pause);
    box.appendChild(row);
  });
}

let lastMediaKey = '';
function handleOfficeState(msg) {
  const first = !officeState;
  officeState = msg;
  const p = msg.ppt;
  if (p) {
    // Cronômetro vem do PC quando a apresentação está rodando
    if (p.inShow && p.elapsed >= 0 && !timerPaused) {
      timerSeconds = p.elapsed;
      updateTimerDisplay();
    }
    els.btnBlack.textContent = p.showState === 'black' ? 'Voltar' : 'Tela preta';
    $('btn-white').textContent = p.showState === 'white' ? 'Voltar' : 'Tela branca';
    els.btnStart.textContent = p.inShow ? 'Reiniciar' : 'Iniciar';
    const key = JSON.stringify(p.media) + p.current;
    if (key !== lastMediaKey) {
      lastMediaKey = key;
      renderMedia(p.media);
    }
    if (first) updateNextPreview();
  } else {
    renderMedia([]);
  }
  renderOffice();
}

function handleOfficeSlides(msg) {
  officeSlidesList = msg.slides || [];
  updateNextPreview();
  renderOffice(true);
}

let officeRenderKey = '';
function renderOffice(force) {
  const st = officeState;
  const docs = st?.docs || [];
  const sel = $('office-docs');
  $('office-empty').classList.toggle('hidden', docs.length > 0);
  sel.classList.toggle('hidden', docs.length === 0);

  // O que está aberto e qual é o alvo -- só refaz o DOM se algo mudou
  const detail = st?.[{ powerpoint: 'ppt', word: 'word', excel: 'excel' }[st?.app]];
  const key = JSON.stringify([st?.docs, st?.target, st?.app, detail && { ...detail, elapsed: 0, notes: 0 }, officeSlidesList.length]);
  if (!force && key === officeRenderKey) return;
  officeRenderKey = key;

  sel.innerHTML = '';
  docs.forEach((d) => {
    const o = document.createElement('option');
    o.value = JSON.stringify(d);
    o.textContent = `${APP_LABEL[d.app] || d.app} · ${d.name}`;
    if (st.target && st.target.app === d.app && st.target.name === d.name) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => {
    const d = JSON.parse(sel.value);
    officeCmd('select', { app: d.app, name: d.name });
  };

  const body = $('office-body');
  body.innerHTML = '';
  if (!st || !detail) return;

  const mkBtn = (text, fn, cls = 'small-btn') => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  };
  const mkList = () => {
    const d = document.createElement('div');
    d.className = 'office-list';
    return d;
  };
  const mkItem = (text, onClick, extraEl, indent = 0, active = false) => {
    const row = document.createElement('div');
    row.className = 'office-row' + (active ? ' active' : '');
    const b = document.createElement('button');
    b.className = 'office-item';
    b.style.paddingLeft = 10 + indent * 12 + 'px';
    b.textContent = text;
    b.addEventListener('click', onClick);
    row.appendChild(b);
    if (extraEl) row.appendChild(extraEl);
    return row;
  };
  const h = (text) => {
    const e = document.createElement('div');
    e.className = 'office-heading';
    e.textContent = text;
    return e;
  };
  const zoomRow = (cmd, pct) => {
    const r = document.createElement('div');
    r.className = 'extra-row';
    r.append(mkBtn('Zoom −', () => officeCmd(cmd, { delta: -10 })), mkBtn(`${pct}%`, () => {}), mkBtn('Zoom +', () => officeCmd(cmd, { delta: 10 })));
    return r;
  };

  if (st.app === 'powerpoint') {
    body.appendChild(h(`Slides (${detail.total})`));
    const list = mkList();
    let lastSection = null;
    officeSlidesList.forEach((s) => {
      if (s.section && s.section !== lastSection) {
        const sec = document.createElement('div');
        sec.className = 'office-section';
        sec.textContent = s.section;
        list.appendChild(sec);
      }
      lastSection = s.section;
      const eye = mkBtn(s.hidden ? '🚫' : '👁', () => officeCmd('ppt.toggleHidden', { index: s.i }));
      eye.title = s.hidden ? 'Mostrar slide' : 'Ocultar slide';
      const row = mkItem(`${s.i}. ${s.title}`, () => sendCommand('goto', { index: s.i }), eye, 0, s.i === detail.current);
      if (s.hidden) row.classList.add('is-hidden');
      list.appendChild(row);
    });
    body.appendChild(list);
  } else if (st.app === 'word') {
    body.appendChild(zoomRow('word.zoom', detail.zoom));
    body.appendChild(h(`Títulos (${detail.headings.length})`));
    const hl = mkList();
    detail.headings.forEach((x) => hl.appendChild(mkItem(x.text || '(vazio)', () => officeCmd('word.goto', { index: x.i }), null, Math.min(x.lead, 8))));
    body.appendChild(hl);
    body.appendChild(h(`Comentários (${detail.comments.length})`));
    const cl = mkList();
    detail.comments.forEach((c) => {
      cl.appendChild(mkItem(`${c.author}: ${c.text}`, () => officeCmd('word.comment', { index: c.i })));
    });
    body.appendChild(cl);
  } else if (st.app === 'excel') {
    body.appendChild(zoomRow('excel.zoom', detail.zoom));
    body.appendChild(h('Planilhas'));
    const sl = mkList();
    detail.sheets.forEach((x) => sl.appendChild(mkItem(x.name, () => officeCmd('excel.sheet', { index: x.i }), null, 0, x.active)));
    body.appendChild(sl);
    if (detail.objects.length) {
      body.appendChild(h('Objetos'));
      const ol = mkList();
      const icon = { name: '🏷', table: '▦', chart: '📊' };
      detail.objects.forEach((x) => ol.appendChild(mkItem(`${icon[x.kind] || ''} ${x.name}`, () => officeCmd('excel.object', { kind: x.kind, index: x.i }))));
      body.appendChild(ol);
    }
  }
}

$('btn-first').addEventListener('click', () => sendCommand('first'));
$('btn-last').addEventListener('click', () => sendCommand('last'));
$('btn-white').addEventListener('click', () => sendCommand('white'));

// =====================================================================
// Modo Bluetooth (só no app Android/APK): o celular vira teclado + mouse
// Bluetooth do PC. Nada é instalado no computador.
// =====================================================================
let btRetryTimer = null;
let btLastState = 'starting';
let btAutoTried = false;
let btUserLeft = false;
let btConnectionInFlight = false;
let btRetryDelay = 2500;
let btMoveAcc = { dx: 0, dy: 0 };
let btMoveTimer = null;

const KEY = { RIGHT: 0x4f, LEFT: 0x50, HOME: 0x4a, END: 0x4d, F5: 0x3e, ESC: 0x29, ENTER: 0x28, B: 0x05, W: 0x1a, L: 0x0f };
const MOD_CTRL = 0x01;
const MOD_SHIFT = 0x02;
const digitUsage = (d) => (d === 0 ? 0x27 : 0x1e + (d - 1));

function btCommandToKeys(msg) {
  switch (msg.command) {
    case 'next': return [{ usage: KEY.RIGHT }];
    case 'prev': return [{ usage: KEY.LEFT }];
    case 'first': return [{ usage: KEY.HOME }];
    case 'last': return [{ usage: KEY.END }];
    case 'white': return [{ usage: KEY.W }];
    case 'black': return [{ usage: KEY.B }];
    case 'start': return [{ usage: KEY.F5, modifiers: msg.fromCurrent ? MOD_SHIFT : 0 }];
    case 'end': return [{ usage: KEY.ESC }];
    case 'laser-on':
    case 'laser-off': return [{ usage: KEY.L, modifiers: MOD_CTRL }];
    case 'goto': {
      const n = Number(msg.index);
      if (!Number.isInteger(n) || n < 1) return null;
      return [...String(n)].map((d) => ({ usage: digitUsage(Number(d)) })).concat([{ usage: KEY.ENTER }]);
    }
    default: return null;
  }
}

function btSend(payload) {
  if (!BtHid) return;
  if (payload.type === 'move') {
    // Junta os movimentos e envia no máximo ~60x/s (evita fila enorme de chamadas nativas).
    btMoveAcc.dx += payload.dx;
    btMoveAcc.dy += payload.dy;
    if (!btMoveTimer) {
      btMoveTimer = setTimeout(() => {
        btMoveTimer = null;
        const sx = Math.round(btMoveAcc.dx);
        const sy = Math.round(btMoveAcc.dy);
        // Guarda o resto fracionario: arrastes lentos (<0,5 px por quadro)
        // eram arredondados para 0 e o cursor nao andava.
        btMoveAcc = { dx: btMoveAcc.dx - sx, dy: btMoveAcc.dy - sy };
        if (sx || sy) BtHid.mouseMove({ dx: sx, dy: sy }).catch(() => {});
      }, 16);
    }
    return;
  }
  if (payload.type === 'click') {
    BtHid.mouseClick({}).catch(() => {});
    return;
  }
  if (payload.type !== 'command') return; // 'office', 'get-history' etc. só existem no modo Wi-Fi
  const keys = btCommandToKeys(payload);
  if (!keys) return;
  const p = keys.length === 1 ? BtHid.sendKey(keys[0]) : BtHid.sendKeys({ keys });
  p.catch((err) => setStatus(false, err?.message || 'Falha ao enviar por Bluetooth'));
}

function btRender(state) {
  btLastState = state.state;
  const msg = document.getElementById('bt-message');
  if (msg) msg.textContent = state.message || '';
  btUpdateGuide(state);
  const connected = state.state === 'connected';
  const onConnectScreen = els.controlScreen.classList.contains('hidden');
  if (connected && !btUserLeft && onConnectScreen) {
    // Conectou (reconexao automatica ao abrir o app, ou o Windows conectou
    // sozinho): entra direto no controle. Antes isso so acontecia com btMode
    // desligado, e a reconexao automatica deixava o app parado na tela de conexao.
    btEnter(state);
    return;
  }
  if (btMode) {
    setStatus(connected, connected ? `Bluetooth: ${state.hostName || 'PC'}` : 'Bluetooth desconectado');
    els.reconnectBanner.textContent = 'Bluetooth caiu — reconectando…';
    els.reconnectBanner.classList.toggle('hidden', connected);
    if (!connected) btScheduleRetry();
    else {
      btRetryDelay = 2500;
      clearTimeout(btRetryTimer);
      btRetryTimer = null;
    }
  }
}

function btUpdateGuide(state = {}) {
  const sel = document.getElementById('bt-device');
  const hasPaired = !!sel?.options.length;
  const connected = state.state === 'connected' || btLastState === 'connected';
  const current = connected ? 3 : hasPaired ? 2 : 1;
  document.querySelectorAll('[data-bt-step]').forEach((step) => {
    const number = Number(step.dataset.btStep);
    step.classList.toggle('active', number === current);
    step.classList.toggle('done', number < current);
  });
}

function btEnter(state) {
  btMode = true;
  document.body.classList.add('bt-mode');
  setActiveTab('slides', { silent: true });
  setStatus(true, `Bluetooth: ${state?.hostName || 'PC'}`);
  showControlScreen();
}

function btLeave() {
  btMode = false;
  btUserLeft = true;
  clearTimeout(btRetryTimer);
  document.body.classList.remove('bt-mode');
  BtHid?.disconnect().catch(() => {});
}

function btScheduleRetry() {
  if (btRetryTimer || btConnectionInFlight || !btMode) return;
  clearTimeout(btRetryTimer);
  btRetryTimer = setTimeout(async () => {
    btRetryTimer = null;
    await btConnectSelected();
  }, btRetryDelay);
  btRetryDelay = Math.min(12000, Math.round(btRetryDelay * 1.6));
}

async function btConnectSelected() {
  if (!BtHid || btConnectionInFlight || !btMode) return null;
  btConnectionInFlight = true;
  try {
    const state = await BtHid.connect({ address: selectedBtAddress() });
    btRender(state);
    return state;
  } catch (err) {
    const msg = document.getElementById('bt-message');
    if (msg && btMode) msg.textContent = err?.message || 'Tentativa de reconexão Bluetooth falhou.';
    return null;
  } finally {
    btConnectionInFlight = false;
    if (btMode && btLastState !== 'connected') btScheduleRetry();
  }
}

function selectedBtAddress() {
  const sel = document.getElementById('bt-device');
  // Mesmo com o <select> escondido (so 1 aparelho pareado) o endereco vale:
  // antes, um PC sem "classe de computador" nunca era encontrado.
  return sel && sel.options.length ? sel.value : undefined;
}

async function btRefreshDevices() {
  try {
    const { devices } = await BtHid.listPaired();
    const sel = document.getElementById('bt-device');
    const computers = devices.filter((d) => d.isComputer);
    const list = computers.length ? computers : devices;
    sel.innerHTML = '';
    list.forEach((d) => {
      const o = document.createElement('option');
      o.value = d.address;
      o.textContent = d.name;
      sel.appendChild(o);
    });
    const last = storageGet('imago-bt-address');
    if (last && list.some((d) => d.address === last)) sel.value = last;
    sel.classList.toggle('hidden', list.length < 2);
    btUpdateGuide({ state: btLastState });
    const msg = document.getElementById('bt-message');
    if (msg && !list.length) msg.textContent = 'Nenhum aparelho pareado. Pareie o PC nas configurações do Android e atualize a lista.';
    return list;
  } catch (err) {
    const msg = document.getElementById('bt-message');
    if (msg) msg.textContent = err?.message || 'Não foi possível listar os aparelhos pareados.';
    return [];
  }
}

async function btStartAndConnect() {
  btUserLeft = false;
  const btn = document.getElementById('btn-bt-connect');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Preparando Bluetooth…';
  try {
    await BtHid.start();
    const devices = await btRefreshDevices();
    if (!devices.length) {
      const msg = document.getElementById('bt-message');
      if (msg) msg.textContent = 'Nenhum PC pareado. Abrindo as configurações Bluetooth…';
      toast('Pareie o celular com o PC e volte ao Imago.');
      await BtHid.openBluetoothSettings();
      return;
    }
    // Alguns aparelhos levam vários segundos para registrar o perfil HID,
    // especialmente logo após ligar o Bluetooth. Espera até 10s em vez de
    // falhar cedo e obrigar o apresentador a tocar várias vezes.
    let readyState = null;
    for (let i = 0; i < 20; i++) {
      readyState = await BtHid.getStatus();
      btRender(readyState);
      if (readyState.state === 'ready' || readyState.state === 'connected') break;
      if (['off', 'no-permission', 'unsupported'].includes(readyState.state)) throw new Error(readyState.message);
      btn.textContent = `Preparando Bluetooth… ${Math.min(99, Math.round(((i + 1) / 20) * 100))}%`;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!readyState || !['ready', 'connected'].includes(readyState.state)) {
      throw new Error('O Bluetooth demorou para iniciar. Ligue o Bluetooth, aguarde alguns segundos e tente novamente.');
    }
    const address = selectedBtAddress();
    if (address) storageSet('imago-bt-address', address);
    btn.textContent = 'Conectando ao PC…';
    const s = await BtHid.connect({ address });
    btRender(s);
    if (s.state === 'connected') btEnter(s);
    else {
      // A conexão pode levar um instante: o evento "state" entra no controle sozinho.
      document.getElementById('bt-message').textContent = 'Conectando… se demorar, confirme o pareamento no Windows.';
    }
  } catch (err) {
    const message = err?.message || 'Não foi possível conectar por Bluetooth.';
    document.getElementById('bt-message').textContent = message;
    toast(message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// Botões de volume (o Android entrega como evento "imagoVolume")
function volumeKeysApply() {
  if (!isApk) return;
  const inControl = !els.controlScreen.classList.contains('hidden');
  const on = inControl && document.getElementById('chk-volume').checked;
  BtHid.setVolumeKeys({ enabled: on }).catch(() => {});
  document.getElementById('volume-row').classList.toggle('hidden', !inControl);
}

if (isApk) {
  document.getElementById('bt-card').classList.remove('hidden');
  if (!loadLastConnection()?.ip) document.getElementById('wifi-card').open = false;
  const chk = document.getElementById('chk-volume');
  chk.checked = storageGet('imago-volume-keys') !== '0';
  chk.addEventListener('change', () => {
    storageSet('imago-volume-keys', chk.checked ? '1' : '0');
    volumeKeysApply();
  });
  window.addEventListener('imagoVolume', (e) => {
    const dir = e.dir ?? e.detail?.dir;
    sendCommand(dir === 'up' ? 'prev' : 'next');
  });
  document.getElementById('btn-bt-connect').addEventListener('click', btStartAndConnect);
  document.getElementById('btn-bt-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-bt-refresh');
    btn.disabled = true;
    await btRefreshDevices();
    btn.disabled = false;
  });
  els.reconnectBanner.addEventListener('click', () => {
    if (!btMode || btLastState === 'connected') return;
    clearTimeout(btRetryTimer);
    btRetryTimer = null;
    btRetryDelay = 0;
    btScheduleRetry();
  });
  document.getElementById('btn-bt-pair').addEventListener('click', async () => {
    try { await BtHid.start(); } catch { /* segue mesmo assim */ }
    BtHid.openBluetoothSettings().catch(() => {});
  });
  BtHid.addListener('state', (s) => btRender(s));
  // Ao voltar das configurações do Android, atualiza a lista. Se acabou de
  // parear um único PC, guarda o endereço e tenta conectar sem exigir outro
  // passo do usuário.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !BtHid || !els.controlScreen.classList.contains('hidden')) return;
    try {
      const devices = await btRefreshDevices();
      const saved = storageGet('imago-bt-address');
      if (!btUserLeft && devices.length === 1 && !saved) {
        storageSet('imago-bt-address', devices[0].address);
        btMode = true;
        const state = await btConnectSelected();
        if (state?.state !== 'connected') btMode = false;
      }
      btRender(await BtHid.getStatus());
    } catch { /* o Android ainda pode estar retomando o Bluetooth */ }
  });
  // Ao abrir o app: registra o teclado Bluetooth e tenta reconectar ao último PC.
  (async () => {
    try {
      await BtHid.start();
      await btRefreshDevices();
      btRender(await BtHid.getStatus());
      if (!btAutoTried && storageGet('imago-bt-address')) {
        btAutoTried = true;
        setTimeout(async () => {
          btMode = true;
          await btConnectSelected();
          if (btLastState !== 'connected') btMode = false;
        }, 1200);
      }
    } catch (err) {
      const m = document.getElementById('bt-message');
      if (m) m.textContent = err?.message || 'Permita o Bluetooth para usar este modo.';
    }
  })();
} else {
  document.getElementById('web-bt-hint').classList.remove('hidden');
}


// ---------- Melhorias v2.1 ----------
// Notas pessoais por slide (salvas no celular)
els.notes.addEventListener('input', () => {
  try { storageSet(notesKey(currentSlideIndex || 0), els.notes.value); } catch { /* sem espaço */ }
});
// Tamanho da letra das notas do apresentador
let notesSize = Number(storageGet('imago-notes-size')) || 14;
function applyNotesSize(d = 0) {
  notesSize = Math.min(28, Math.max(11, notesSize + d));
  els.slideNotes.style.fontSize = notesSize + 'px';
  storageSet('imago-notes-size', String(notesSize));
}
document.getElementById('btn-notes-minus').addEventListener('click', () => applyNotesSize(-2));
document.getElementById('btn-notes-plus').addEventListener('click', () => applyNotesSize(2));
applyNotesSize();
// Sensibilidade do laser
const sensEl = document.getElementById('laser-sens');
laserSens = Number(storageGet('imago-laser-sens')) || 2.2;
sensEl.value = laserSens;
sensEl.addEventListener('input', () => {
  laserSens = Number(sensEl.value);
  storageSet('imago-laser-sens', String(laserSens));
});
// Atalhos de teclado (útil ao usar o app no computador/tablet)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (els.controlScreen.classList.contains('hidden') || /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); sendCommand('next'); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); sendCommand('prev'); }
});
// Sem relay configurado, o campo de código para dados móveis só confunde
if (RELAY_NOT_CONFIGURED) els.inputCode.closest('.field')?.classList.add('hidden');

// ---------- Guia de instalação (só no navegador; APK e app instalado não mostram) ----------
(function setupInstallCard() {
  if (isApk || isStandalone) return;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const android = /Android/i.test(ua);
  const body = document.getElementById('install-body');
  const mk = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
  let user = 'paulusxavier', repo = 'Imago';
  if (location.hostname.endsWith('.github.io')) {
    user = location.hostname.split('.')[0];
    repo = location.pathname.split('/')[1] || repo;
  }
  const apk = mk('a', android ? '⬇ Baixar app Android (APK)' : 'Baixar APK Android', 'install-link');
  apk.href = `https://github.com/${user}/${repo}/releases/download/apk-latest/Imago.apk`;
  const webBtn = mk('button', 'Instalar a versão web', 'link-btn');
  webBtn.id = 'btn-install';
  if (ios) {
    body.append(mk('p', 'No Chrome/Android, a versão web pode usar Bluetooth experimental. No iPhone/iPad, use Wi-Fi/internet: no Safari, toque em Compartilhar e escolha "Adicionar à Tela de Início".'));
  } else {
    body.append(mk('p', android
      ? 'Recomendado: o app Android usa Bluetooth e não precisa instalar nada no PC.'
      : 'Abra este endereço no celular para instalar. No Android, baixe o APK para usar por Bluetooth.'));
    body.append(apk);
    if (android) body.append(mk('p', 'Ao abrir o arquivo, permita "instalar apps desta fonte" quando o Android pedir.', 'hint'));
    body.append(webBtn);
  }
  document.getElementById('install-card').classList.remove('hidden');
  webBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      toast('Toque no menu do navegador (⋮) e escolha "Instalar app" ou "Adicionar à tela inicial".');
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
  window.addEventListener('appinstalled', () => document.getElementById('install-card').classList.add('hidden'));
})();

// ---------- Link para baixar o programa do PC (Windows) ----------
(function setupPcDownload() {
  let user = 'paulusxavier', repo = 'Imago';
  if (location.hostname.endsWith('.github.io')) {
    user = location.hostname.split('.')[0];
    repo = location.pathname.split('/')[1] || repo;
  }
  const url = `https://github.com/${user}/${repo}/releases/download/pc-latest/Imago-PC-Windows.zip`;
  const box = document.createElement('div');
  box.className = 'pc-download';
  const p = document.createElement('p');
  p.textContent = 'Para notas, miniaturas e Office, instale o Imago no PC (Windows). Extraia o zip e abra o Imago.exe: um QR code aparece na tela.';
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '⬇ Baixar Imago para Windows';
  a.className = 'install-link pc-link';
  box.append(p, a);
  document.getElementById('wifi-card').append(box);
})();

// ---------- Tela de conexão: validação, colar link, reconectar rápido ----------
const formErrorEl = document.getElementById('form-error');
function showFormError(msg, fields = []) {
  formErrorEl.textContent = msg;
  formErrorEl.classList.toggle('hidden', !msg);
  [els.inputIp, els.inputPort, els.inputToken, els.inputCode].forEach((f) => f.classList.toggle('invalid', fields.includes(f)));
}
function validateConnectForm() {
  const ip = els.inputIp.value.trim();
  const port = els.inputPort.value.trim();
  const code = els.inputCode.value.trim();
  if (networkMode === 'wifi' && !ip) return ['No modo Wi-Fi, informe o IP local do PC.', [els.inputIp]];
  if (networkMode === 'internet' && !code) return ['No modo dados móveis, informe o código de 6 dígitos.', [els.inputCode]];
  if (networkMode === 'auto' && !ip && !code) return ['Informe o IP do PC ou cole o link do QR code.', [els.inputIp]];
  if (ip && !/^[\w.\-]+$/.test(ip)) return ['O IP parece inválido. Exemplo: 192.168.0.10', [els.inputIp]];
  if (port && (!/^\d{2,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return ['A porta deve estar entre 1 e 65535. Exemplo: 8765', [els.inputPort]];
  if (networkMode !== 'wifi' && code && !/^\d{6}$/.test(code)) return ['O código do relay deve ter 6 dígitos.', [els.inputCode]];
  if (!els.inputToken.value.trim() && !sessionToken) return ['Digite o código de segurança que aparece na tela do PC.', [els.inputToken]];
  return null;
}
[...document.querySelectorAll('[data-network-mode]')].forEach((button) => {
  button.addEventListener('click', () => setNetworkMode(button.dataset.networkMode));
});
setNetworkMode(networkMode);
[els.inputIp, els.inputPort, els.inputToken, els.inputCode].forEach((f) => f.addEventListener('input', () => showFormError('')));
els.inputToken.addEventListener('input', () => { els.inputToken.value = els.inputToken.value.toUpperCase().replace(/\s/g, ''); });
document.querySelectorAll('#wifi-card input').forEach((f) => f.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleConnect(); }));
// Le o link do QR (http://IP:porta/?ip=&port=&token=&code=) e devolve os dados,
// ou null se nao for um link do Imago. Usado ao colar o link e ao escanear o QR.
function parseImagoLink(text) {
  let u;
  try { u = new URL(String(text ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const p = u.searchParams;
  const ip = (p.get('ip') || '').trim();
  const code = (p.get('code') || '').trim();
  const port = (p.get('port') || '').trim();
  if (!ip && !code) return null;
  if (ip && !/^[\w.\-]+$/.test(ip)) return null;
  if (port && (!/^\d{2,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (code && !/^\d{6}$/.test(code)) return null;
  return { ip, port, code, token: (p.get('token') || '').trim().toUpperCase() };
}
function applyConnectionLink(text) {
  const d = parseImagoLink(text);
  if (!d) return false;
  // O link descreve UM PC por inteiro: campos que ele nao traz sao limpos, senao
  // o codigo do relay / a porta de outro PC (salvos antes) ficariam misturados.
  els.inputIp.value = d.ip;
  els.inputPort.value = d.port;
  els.inputCode.value = d.code;
  sessionToken = d.token;
  els.inputToken.value = d.token;
  showFormError('');
  return true;
}
document.getElementById('input-link').addEventListener('input', (e) => {
  if (!applyConnectionLink(e.target.value)) return; // ainda não é um link completo
  e.target.value = '';
  toast('Link lido. Toque em Conectar.');
});

// ---------- Escanear o QR code do PC pela câmera ----------
// A câmera só abre por HTTPS (site publicado) ou dentro do app Android; o
// decodificador (jsqr.min.js) é local e só é carregado na primeira leitura.
const qrEls = {
  button: document.getElementById('btn-scan-qr'),
  overlay: document.getElementById('qr-scanner'),
  video: document.getElementById('qr-video'),
  msg: document.getElementById('qr-scan-msg'),
  cancel: document.getElementById('btn-scan-cancel'),
};
let qrStream = null;
let qrTimer = 0;
let qrSession = 0;
let jsQrLoading = null;

function loadJsQr() {
  if (typeof window.jsQR === 'function') return Promise.resolve(window.jsQR);
  if (jsQrLoading) return jsQrLoading;
  jsQrLoading = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'jsqr.min.js';
    tag.onload = () => (typeof window.jsQR === 'function' ? resolve(window.jsQR) : reject(new Error('jsqr-missing')));
    tag.onerror = () => reject(new Error('jsqr-missing'));
    document.head.appendChild(tag);
  }).catch((err) => { jsQrLoading = null; throw err; });
  return jsQrLoading;
}

function closeQrScanner() {
  qrSession++;
  clearTimeout(qrTimer);
  if (qrStream) qrStream.getTracks().forEach((t) => t.stop());
  qrStream = null;
  qrEls.video.srcObject = null;
  qrEls.overlay.classList.add('hidden');
}

function qrCameraError(err) {
  const name = err?.name || err?.message || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'Sem permissão para usar a câmera. Libere a câmera para o Imago nas configurações do celular, ou cole o link / digite o IP.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'Não encontrei uma câmera neste aparelho.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'A câmera está sendo usada por outro app. Feche-o e tente de novo.';
  if (name === 'jsqr-missing') return 'Não consegui carregar o leitor de QR. Conecte à internet uma vez para baixá-lo, ou cole o link.';
  return 'Não foi possível abrir a câmera. Cole o link do PC ou digite o IP.';
}

async function openQrScanner() {
  if (!qrEls.overlay.classList.contains('hidden') || !els.controlScreen.classList.contains('hidden')) return;
  if (!navigator.mediaDevices?.getUserMedia || (!window.isSecureContext && !isApk)) {
    toast('A câmera só funciona pelo app Android ou pelo site em HTTPS. Aqui, cole o link ou digite o IP.');
    return;
  }
  const session = ++qrSession;
  qrEls.msg.textContent = 'Abrindo a câmera…';
  qrEls.overlay.classList.remove('hidden');
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (session !== qrSession) { stream.getTracks().forEach((t) => t.stop()); return; } // cancelou enquanto abria
    const jsQR = await loadJsQr();
    if (session !== qrSession) { stream.getTracks().forEach((t) => t.stop()); return; }
    qrStream = stream;
    qrEls.video.srcObject = stream;
    await qrEls.video.play().catch(() => {});
    qrEls.msg.textContent = 'Aponte para o QR code que aparece na tela do PC.';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (session !== qrSession) return;
      const v = qrEls.video;
      if (v.readyState >= 2 && v.videoWidth) {
        const scale = Math.min(1, 640 / v.videoWidth);
        const w = Math.max(1, Math.round(v.videoWidth * scale));
        const h = Math.max(1, Math.round(v.videoHeight * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const found = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (found?.data) {
          if (applyConnectionLink(found.data)) {
            closeQrScanner();
            vibrate(40);
            toast('QR code lido. Conectando…');
            handleConnect();
            return;
          }
          qrEls.msg.textContent = 'Esse QR code não é do Imago. Aponte para o QR da tela do PC.';
        }
      }
      qrTimer = setTimeout(tick, 120);
    };
    tick();
  } catch (err) {
    if (stream && stream !== qrStream) stream.getTracks().forEach((t) => t.stop());
    if (session === qrSession) {
      closeQrScanner();
      toast(qrCameraError(err));
    }
  }
}

qrEls.button.addEventListener('click', openQrScanner);
qrEls.cancel.addEventListener('click', closeQrScanner);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !qrEls.overlay.classList.contains('hidden')) closeQrScanner(); });
// So fecha ao ir para segundo plano se a camera ja estiver aberta: o pedido de
// permissao do Android pode pausar a pagina, e fechar nessa hora cancelava a leitura.
document.addEventListener('visibilitychange', () => { if (document.hidden && qrStream) closeQrScanner(); });
// Em http:// (pagina servida pelo proprio PC) o navegador nao libera a camera: esconde o botao.
if (!isApk && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) qrEls.button.classList.add('hidden');
if (isApk) document.getElementById('net-divider').classList.remove('hidden');
if (!isApk) {
  els.webBleCard?.classList.remove('hidden');
  els.webBleButton?.addEventListener('click', connectWebBluetooth);
  if (!navigator.bluetooth) setWebBleMessage('Este navegador não oferece Web Bluetooth. Use Chrome no Android.');
  else if (!window.isSecureContext) setWebBleMessage('Abra o Imago por HTTPS para liberar Bluetooth web.');
}

const openedFromQr = prefillFromUrl();
prefillFromStorage();
(function quickReconnect() {
  const last = loadLastConnection();
  if (!last || (!last.ip && !last.code)) return;
  const q = document.getElementById('btn-quick');
  q.textContent = `↻ Reconectar ${last.ip ? 'ao PC ' + last.ip : 'pela internet'}`;
  q.classList.remove('hidden');
  q.addEventListener('click', handleConnect);
  document.getElementById('wifi-card').open = true;
})();

// Abriu pelo link do QR (traz IP + codigo de seguranca)? Conecta sozinho, como
// o Office Remote: escanear e pronto.
if (openedFromQr && sessionToken && !isApk) {
  setTimeout(() => { if (!socket && !btMode) handleConnect(); }, 150);
}

if ('serviceWorker' in navigator && !isApk) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Se a conexão cair por uma troca de rede, tenta retomar assim que o aparelho
// voltar a ficar online, sem exigir que o apresentador refaça o pareamento.
window.addEventListener('offline', () => {
  if (!els.controlScreen.classList.contains('hidden')) {
    setStatus(false, 'Sem internet — aguardando a rede');
    toast('A rede caiu. O Imago tentará reconectar automaticamente.');
  }
});
window.addEventListener('online', () => {
  if (!els.controlScreen.classList.contains('hidden') && socket?.readyState !== WebSocket.OPEN) {
    toast('Rede disponível. Tentando reconectar…');
    attemptAutoReconnect();
  }
});
