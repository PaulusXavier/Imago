// IMPORTANTE: coloque aqui a URL do SEU relay publicado (ex: no Render),
// a mesma usada em pc-controller/controller.js na variavel RELAY_URL.
const RELAY_URL = 'wss://SEU-RELAY.onrender.com';

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
let timerInterval = null;
let timerSeconds = 0;
let wakeLock = null;
let userInitiatedDisconnect = false;
let reconnectAttempts = 0;
let lastConnectionParams = null; // { ip, port, code, token }
// Codigo de seguranca do Imago atual -- vem do QR/link (?token=...) ou de
// uma conexao anterior salva. Sem o token certo, o PC recusa a conexao (ver
// controller.js): assim, so quem escaneou o QR (ou digitou o codigo que
// aparece na tela do PC) consegue controlar a apresentacao.
let sessionToken = '';
let isReconnecting = false;
let activeTab = 'slides';
let currentSlideIndex = null;
let thumbItems = new Map(); // index -> { wrapper, img }

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
      alert(
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
}
function loadLastConnection() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function setStatus(connected, text) {
  els.statusDot.classList.toggle('connected', connected);
  els.statusText.textContent = text;
}

function showControlScreen() {
  els.connectScreen.classList.add('hidden');
  els.controlScreen.classList.remove('hidden');
  els.reconnectBanner.classList.add('hidden');
  startTimer();
  acquireWakeLock();
}

function showConnectScreen() {
  els.controlScreen.classList.add('hidden');
  els.connectScreen.classList.remove('hidden');
  stopTimer();
  releaseWakeLock();
  resetThumbsGrid();
  setActiveTab('slides', { silent: true });
}

function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
}
function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  els.timer.textContent = `${m}:${s}`;
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}
function sendCommand(command, extra) {
  vibrate();
  send({ type: 'command', command, ...extra });
}

// ---------- Conexão ----------
function updateSlideInfo(msg) {
  els.slideInfo.classList.remove('hidden');
  els.slideCounter.textContent = `Slide ${msg.index} de ${msg.total}`;
  els.slideTitle.textContent = msg.title || '';
  els.slideNotes.textContent = msg.notes || '';
  currentSlideIndex = msg.index;
  highlightActiveThumb();
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
  item.img.src = dataUrl;
  item.img.hidden = false;
  item.wrapper.classList.remove('skeleton');
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
    if (msg.type === 'slide-info') updateSlideInfo(msg);
    else if (msg.type === 'thumbs-status') handleThumbsStatus(msg);
    else if (msg.type === 'slide-thumb') handleSlideThumb(msg);
    else if (msg.type === 'history') renderHistory(msg.sessions || []);
  });
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
      if (msg.type === 'hello-ok') settle(resolve, ws);
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

async function connectRelay(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    let settled = false;
    let helloTimeout = null;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(helloTimeout);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      fn(value);
    }
    function onMessage(event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignora mensagem invalida em vez de derrubar a conexao
      }
      if (msg.type === 'joined') {
        // Entrou na sessão pelo código -- ainda falta provar que também
        // tem o codigo de seguranca (token) antes do PC liberar comandos.
        ws.send(JSON.stringify({ type: 'hello', token: sessionToken }));
        helloTimeout = setTimeout(() => {
          settle(reject, new Error('auth-failed'));
          ws.close();
        }, RELAY_HELLO_TIMEOUT_MS);
        return;
      }
      if (msg.type === 'hello-ok') {
        settle(resolve, ws);
        return;
      }
      if (msg.type === 'error') settle(reject, new Error(msg.message));
      // 'pc-disconnected': o servidor ja fecha esta conexao logo em seguida
      // (o que aciona a reconexao automatica sozinho), isso aqui e so uma
      // rede de seguranca caso essa conexao demore a fechar de verdade.
      if (msg.type === 'pc-disconnected') ws.close();
    }
    function onError() {
      settle(reject, new Error('relay-failed'));
    }

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', code })));
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
  });
}

async function tryConnect({ ip, port, code }) {
  if (ip) {
    try {
      return await connectLocal(ip, port || '8765');
    } catch {
      /* cai para o relay */
    }
  }
  if (code) {
    return await connectRelay(code);
  }
  throw new Error('sem-dados-de-conexao');
}

async function handleConnect() {
  if (els.inputToken?.value.trim()) sessionToken = els.inputToken.value.trim().toUpperCase();
  const params = {
    ip: els.inputIp.value.trim(),
    port: els.inputPort.value.trim() || '8765',
    code: els.inputCode.value.trim(),
    token: sessionToken,
  };
  setStatus(false, 'Conectando...');
  els.btnConnect.disabled = true;

  try {
    const ws = await tryConnect(params);
    socket = ws;
    userInitiatedDisconnect = false;
    reconnectAttempts = 0;
    lastConnectionParams = params;
    saveLastConnection(params);
    wireSocketLifecycle(ws);
    wireIncomingMessages(ws);
    setStatus(true, ws.url?.startsWith('ws://') ? 'Conectado (rede local)' : 'Conectado (internet)');
    showControlScreen();
  } catch (err) {
    setStatus(false, 'Falha ao conectar');
    if (err.message === 'auth-failed') {
      alert('Código de segurança incorreto ou ausente. Escaneie o QR code de novo (ele muda toda vez que o Imago abre).');
    } else {
      alert('Não foi possível conectar: informe o IP local ou o código do relay.');
    }
  } finally {
    els.btnConnect.disabled = false;
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
  els.reconnectBanner.classList.remove('hidden');
  setStatus(false, `Reconectando... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  const delay = Math.min(1000 * reconnectAttempts, 5000);
  await new Promise((r) => setTimeout(r, delay));

  try {
    const ws = await tryConnect(lastConnectionParams);
    socket = ws;
    reconnectAttempts = 0;
    wireSocketLifecycle(ws);
    wireIncomingMessages(ws);
    els.reconnectBanner.classList.add('hidden');
    setStatus(true, 'Reconectado');
    isReconnecting = false;
  } catch {
    isReconnecting = false;
    attemptAutoReconnect();
  }
}

function handleDisconnect() {
  userInitiatedDisconnect = true;
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
  history: { tab: 'tabHistory', panel: 'historyPanel' },
};

function setActiveTab(name, { silent } = {}) {
  const wasLaser = activeTab === 'laser';
  activeTab = name;
  Object.entries(TABS).forEach(([key, refs]) => {
    els[refs.tab].classList.toggle('active', key === name);
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
function onTouchStart(e) {
  const t = e.touches[0];
  touchLast = { x: t.clientX, y: t.clientY };
  els.touchpad.classList.add('dragging');
}
function onTouchMove(e) {
  e.preventDefault();
  if (!touchLast) return;
  const t = e.touches[0];
  const dx = (t.clientX - touchLast.x) * 2.2;
  const dy = (t.clientY - touchLast.y) * 2.2;
  touchLast = { x: t.clientX, y: t.clientY };
  send({ type: 'move', dx, dy });
}
function onTouchEnd() {
  touchLast = null;
  els.touchpad.classList.remove('dragging');
}

// ---------- Gesto de arrastar para trocar slide ----------
let slideSwipeStartX = null;
function onSlideTouchStart(e) {
  slideSwipeStartX = e.touches[0].clientX;
}
function onSlideTouchEnd(e) {
  if (slideSwipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - slideSwipeStartX;
  if (Math.abs(dx) > 60) sendCommand(dx < 0 ? 'next' : 'prev');
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
els.btnEnd.addEventListener('click', () => sendCommand('end'));
els.tabSlides.addEventListener('click', () => setActiveTab('slides'));
els.tabThumbs.addEventListener('click', () => setActiveTab('thumbs'));
els.tabLaser.addEventListener('click', () => setActiveTab('laser'));
els.tabHistory.addEventListener('click', () => setActiveTab('history'));

els.touchpad.addEventListener('touchstart', onTouchStart, { passive: true });
els.touchpad.addEventListener('touchmove', onTouchMove, { passive: false });
els.touchpad.addEventListener('touchend', onTouchEnd);

els.slidesPanel.addEventListener('touchstart', onSlideTouchStart, { passive: true });
els.slidesPanel.addEventListener('touchend', onSlideTouchEnd);

prefillFromUrl();
prefillFromStorage();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
