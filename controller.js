// Roda no PC durante a apresentacao (PowerPoint ou Prezi ja abertos, em modo
// apresentacao). Este script:
//
//   1) Abre um servidor local (WebSocket) na rede Wi-Fi, para o celular se
//      conectar DIRETO quando estiver na mesma rede -- funciona mesmo sem
//      internet (offline).
//   2) Tambem se conecta a um servidor "relay" na internet, para o caso do
//      celular estar em dados moveis / rede diferente.
//   3) Ao receber um comando ("next", "prev", "black", etc.) simula a tecla
//      correspondente, que funciona tanto no PowerPoint quanto no Prezi.
//   4) Se um arquivo .pptx for informado (PPTX_PATH), le o titulo e as notas
//      do apresentador de cada slide e manda pro celular conforme voce navega.
//   5) Gera miniaturas reais de cada slide (via LibreOffice + Poppler) e manda
//      pro celular -- ve o modules.js (thumbnails) para detalhes.
//   6) Guarda um historico local das ultimas apresentacoes (data, duracao,
//      ate onde os slides foram vistos) -- ve modules.js (history).
//
// Configuracao: edite as constantes abaixo ou use variaveis de ambiente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { config: appConfig, setup, thumbnails, history, updater, office, pptx, network } = require('./modules');
const http = require('http');
const webBleBridge = require('./web-ble-bridge');

// Uma excecao inesperada (mensagem estranha de um cliente, erro de um socket...)
// nao pode derrubar o Imago no meio de uma apresentacao: registra e segue.
process.on('uncaughtException', (err) => {
  console.log('[Erro] Excecao nao tratada (o Imago continua rodando):', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.log('[Erro] Promessa rejeitada sem tratamento (o Imago continua rodando):', err && err.message ? err.message : err);
});

// "Imago.exe --configurar" abre o assistente de configuracao em vez de
// iniciar o controle normalmente -- e o que o atalho "Configurar" (veja
// README) chama. Isso fica logo no topo do arquivo, ANTES de carregar
// robotjs/ws/etc., pra configurar continuar funcionando mesmo se algum
// desses modulos tiver problema pra carregar (ex: modulo nativo ausente).
if (process.argv.includes('--configurar') || process.argv.includes('--config')) {
  setup
    .runWizard()
    .then(() => process.exit(0))
    .catch((err) => {
      console.log('[Erro] Falha ao rodar a configuracao:', err.message);
      process.exit(1);
    });
  return;
}

// "Imago.exe --aplicar-atualizacao <pid> <pasta> <pasta-extraida>" e chamado
// automaticamente pelo proprio Imago (veja updater em modules.js) quando ha uma
// atualizacao ja baixada esperando pra ser aplicada -- nao e algo que quem
// usa o app chama na mao. Fica aqui em cima, antes do robotjs, pelo mesmo
// motivo do --configurar: nao precisa de robotjs pra trocar arquivos.
if (process.argv.includes('--aplicar-atualizacao')) {
  updater
    .applyPendingUpdate(process.argv)
    .then(() => process.exit(0))
    .catch((err) => {
      console.log('[Atualização] Falha ao aplicar atualização:', err.message);
      process.exit(1);
    });
  return;
}

// Modulos nativos (robotjs) nao podem ser embutidos dentro de um .exe
// gerado pelo "pkg" -- por isso, quando empacotado, carregamos a copia que
// o build-copy-native.js deixou do lado do executavel, de fora do pacote.
// A variavel (em vez de uma string literal) e de proposito: assim o "pkg"
// nao tenta (e falha) empacotar o robotjs dentro do .exe.
const robotModuleDir = process.pkg
  ? path.join(path.dirname(process.execPath), 'node_modules', 'robotjs')
  : 'robotjs';
let robot;
try {
  robot = require(robotModuleDir);
} catch (err) {
  if (process.platform === 'win32') robot = createWindowsInputShim(err);
  if (!robot) {
    console.log('[Erro fatal] Nao consegui carregar o robotjs (controle de teclado/mouse):', err.message);
    if (process.pkg) {
      console.log('             Confira se a pasta "node_modules" esta do lado do Imago.exe (nao mova o .exe sozinho pra fora da pasta).');
    } else {
      console.log('             Rode "npm install" na pasta do Imago.');
    }
    process.exit(1);
  }
}

const { WebSocketServer, WebSocket } = require('ws');
const qrcode = require('qrcode-terminal');

// RELAY_URL e WEB_APP_URL sao preenchidos UMA VEZ por quem publicou o Imago
// (veja README > "Configuracao unica"), antes de gerar o instalavel/.exe que
// todo mundo vai usar. Quem so vai USAR o app no dia a dia nunca precisa
// mexer aqui -- por isso nao ficam num arquivo de config separado.
const LOCAL_PORT = process.env.LOCAL_PORT || 8765;
const RELAY_URL = process.env.RELAY_URL || 'wss://SEU-RELAY.onrender.com';
// URL onde a PWA (raiz do repositorio) esta publicada, ex: https://paulusxavier.github.io/Imago
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://paulusxavier.github.io/Imago';
// Onde o Imago procura por versoes novas para se atualizar sozinho. Por
// padrao e um arquivo "version.json" do lado da PWA acima (mesmo GitHub
// Pages, sem precisar publicar nada a mais) -- so precisa apontar pra outro
// lugar se quiser hospedar o manifesto em outro endereco. Veja README >
// "Publicando atualizacoes".
const UPDATE_MANIFEST_URL = process.env.UPDATE_MANIFEST_URL || `${WEB_APP_URL.replace(/\/$/, '')}/version.json`;
const CURRENT_VERSION = require('./package.json').version;
const RELAY_NOT_CONFIGURED = /SEU-RELAY/i.test(RELAY_URL);
let relayRetryTimer = null;
let relayRetryDelayMs = 5000;
let relayConfigWarningShown = false;

// ---------- Codigo de seguranca da sessao ----------
// Sem isso, qualquer aparelho na mesma rede Wi-Fi conseguiria se conectar
// direto no servidor local (ou adivinhar o codigo de 4 digitos do relay) e
// controlar a apresentacao sem nunca ter escaneado o QR code. Este codigo e
// gerado do zero toda vez que o Imago abre, vai embutido no QR/link (campo
// "token") e tambem e exigido como primeira mensagem de qualquer conexao
// (local ou relay) antes de aceitar qualquer comando -- ver mais abaixo.
// Alfabeto sem caracteres ambiguos (sem 0/O, 1/I/L) para dar pra digitar na
// mao se o QR nao puder ser escaneado.
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateSessionToken(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out;
}
const SESSION_TOKEN = generateSessionToken();

// Compara duas strings em tempo constante (evita vazar, por timing, quantos
// caracteres do token estao certos) -- so usamos crypto.timingSafeEqual
// quando os tamanhos batem; tamanhos diferentes ja sao invalidos.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

if (RELAY_NOT_CONFIGURED) {
  console.log('[Aviso] RELAY_URL e/ou WEB_APP_URL ainda estao com o valor de exemplo.');
  console.log('        Se isso nao for so um teste local, configure-os antes de distribuir o instalavel');
  console.log('        (veja README > "Configuracao unica" > passo 3).\n');
}

// ---------- Apresentacao (.pptx) configurada ----------
// Prioridade: 1) arquivo arrastado em cima do app (argumento na linha de
// comando) 2) variavel de ambiente PPTX_PATH (uso avancado) 3) config.json
// salvo pelo assistente "npm run configurar". Isso evita ter que editar
// codigo pra usar o app -- e o mais parecido possivel com so abrir o
// programa, como no Office Remote.
const draggedFile = process.argv[2];
let PPTX_PATH = process.env.PPTX_PATH || '';

if (!PPTX_PATH && draggedFile && draggedFile.toLowerCase().endsWith('.pptx')) {
  PPTX_PATH = draggedFile;
  appConfig.save({ pptxPath: PPTX_PATH });
  console.log(`[Config] Apresentacao salva a partir do arquivo arrastado: ${PPTX_PATH}`);
}

if (!PPTX_PATH) {
  const saved = appConfig.load();
  if (saved.pptxPath) {
    if (fs.existsSync(saved.pptxPath)) {
      PPTX_PATH = saved.pptxPath;
    } else {
      console.log(`[Aviso] A apresentacao configurada nao foi encontrada: ${saved.pptxPath}`);
      console.log('        Rode "npm run configurar" de novo ou arraste o .pptx sobre o Imago.');
    }
  }
}

if (!PPTX_PATH) {
  console.log('[Dica] Nenhuma apresentacao configurada ainda -- notas e miniaturas ficam desativadas.');
  console.log('       Pra ativar: arraste o arquivo .pptx em cima do Imago, ou rode "npm run configurar".');
  console.log('       A navegacao de slides funciona normalmente sem isso.\n');
}

// ---------- Leitura do .pptx (titulo e notas de cada slide) ----------
// A leitura fica em modules.js (pptx) para poder ser testada; respeita a ordem
// real dos slides e as notas de cada um.
const slidesData = pptx.load(PPTX_PATH);
let currentSlide = slidesData.length ? 1 : 0;

// ---------- Conexoes ativas (para poder mandar mensagens pra elas) ----------
let localWss = null; // servidor local (HTTP + WebSocket), criado mais abaixo
let currentRelayWs = null;
let webBle = { broadcast() {} };
// Vira true so depois que o lado do relay manda o "hello" com o token
// correto (ver connectRelay abaixo) -- broadcast() nao manda nada sensivel
// (notas do apresentador, miniaturas) pro relay antes disso.
let relayAuthorized = false;

function safeSend(ws, json) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(json);
  } catch { /* conexao caindo: o 'close' cuida da limpeza */ }
}

function broadcast(payload) {
  const json = JSON.stringify(payload);
  // Todos os celulares/tablets autenticados na rede local recebem (antes so o ultimo).
  if (localWss) {
    localWss.clients.forEach((client) => { if (client.authorized) safeSend(client, json); });
  }
  if (relayAuthorized) safeSend(currentRelayWs, json);
  webBle.broadcast(payload);
}

// ---------- Estado real do Office (via ponte COM, so no Windows) ----------
// Quando o PowerPoint esta aberto, ele e a fonte da verdade (slide atual,
// titulo, notas, total) -- assim o Imago nao dessincroniza se alguem mexer
// no teclado do PC. Sem a ponte, cai no .pptx configurado + teclas simuladas.
let officeState = null; // ultimo {type:'state'}
let officeSlides = null; // ultimo {type:'slides'}

function usingOffice() {
  return office.isRunning() && officeState?.app === 'powerpoint' && !!officeState.ppt;
}
function totalSlides() {
  if (usingOffice()) return officeState.ppt.total;
  return slidesData.length;
}

function broadcastSlideInfo() {
  if (usingOffice()) {
    const p = officeState.ppt;
    if (p.total < 1) return;
    broadcast({ type: 'slide-info', index: p.current, total: p.total, title: p.title, notes: p.notes });
    return;
  }
  if (!slidesData.length || currentSlide < 1) return;
  const info = slidesData[currentSlide - 1];
  broadcast({
    type: 'slide-info',
    index: currentSlide,
    total: slidesData.length,
    title: info.title,
    notes: info.notes,
  });
}

function getLocalIp() {
  return network.bestLocalIp();
}

// ---------- Historico de sessoes ----------
let activeSession = null;

function beginSessionHistory() {
  // "Iniciar" duas vezes seguidas (ou apresentar pelo proprio PC e depois pelo
  // celular) nao pode descartar a sessao anterior: salva antes de abrir a nova.
  endSessionHistory();
  activeSession = history.startSession({
    slidesTotal: totalSlides(),
    pptxName: usingOffice() ? officeState.ppt.name : PPTX_PATH ? path.basename(PPTX_PATH) : null,
  });
}

function endSessionHistory() {
  if (!activeSession) return;
  history.finishAndSave(activeSession);
  activeSession = null;
}

function sendHistoryTo(ws) {
  safeSend(ws, JSON.stringify({ type: 'history', sessions: history.getRecent(10) }));
}

// Encerra e salva a sessao em andamento se o script for fechado no meio de
// uma apresentacao (Ctrl+C no terminal), pra nao perder o registro.
process.on('SIGINT', () => {
  endSessionHistory();
  process.exit(0);
});

// ---------- Miniaturas dos slides ----------
const thumbsCache = new Map(); // index (1-based) -> data URL
let thumbsAvailable = null; // null = ainda nao verificado, true/false depois
let thumbsReason = null;
let thumbsGenerating = false;

function broadcastThumbsStatus() {
  broadcast({
    type: 'thumbs-status',
    available: thumbsAvailable === true,
    generating: thumbsGenerating,
    total: totalSlides(),
    reason: thumbsReason,
  });
}

function sendThumbsStatusTo(ws) {
  safeSend(
    ws,
    JSON.stringify({
      type: 'thumbs-status',
      available: thumbsAvailable === true,
      generating: thumbsGenerating,
      total: totalSlides(),
      reason: thumbsReason,
    })
  );
}

// Manda pra uma conexao especifica todas as miniaturas ja prontas ate agora
// (usado quando um celular conecta/reconecta depois que a geracao comecou).
function sendCachedThumbsTo(ws) {
  if (!ws || thumbsCache.size === 0) return;
  let delay = 0;
  for (const [index, dataUrl] of thumbsCache.entries()) {
    setTimeout(() => {
      safeSend(ws, JSON.stringify({ type: 'slide-thumb', index, total: totalSlides(), dataUrl }));
    }, delay);
    delay += 40; // espalha o envio pra nao travar conexoes mais lentas (relay)
  }
}

function startThumbnailGeneration() {
  if (!PPTX_PATH || !slidesData.length) {
    thumbsAvailable = false;
    thumbsReason = 'sem-slides';
    return;
  }
  thumbsGenerating = true;
  broadcastThumbsStatus();

  thumbnails.generateThumbnails(
    PPTX_PATH,
    slidesData.length,
    (index, dataUrl) => {
      thumbsCache.set(index, dataUrl);
      broadcast({ type: 'slide-thumb', index, total: totalSlides(), dataUrl });
    },
    (ok, reason) => {
      thumbsGenerating = false;
      thumbsAvailable = ok;
      thumbsReason = reason;
      broadcastThumbsStatus();
      if (!ok) {
        const tools = thumbnails.checkTools();
        console.log(
          `[Aviso] Miniaturas dos slides desativadas (${reason}). LibreOffice encontrado: ${tools.soffice}, Poppler (pdftoppm) encontrado: ${tools.pdftoppm}.`
        );
        console.log(
          '        Instale as duas ferramentas (ou configure SOFFICE_PATH/PDFTOPPM_PATH) para ativar as miniaturas. A navegacao e as notas continuam funcionando normalmente.'
        );
      } else {
        console.log(`[Miniaturas] ${thumbsCache.size} miniatura(s) geradas com sucesso.`);
      }
    }
  );
}

// ---------- Comandos ----------
let laserActive = false;

function setCurrentSlide(index) {
  if (!slidesData.length) return;
  currentSlide = Math.max(1, Math.min(slidesData.length, index));
  if (activeSession) {
    activeSession.maxSlideReached = Math.max(activeSession.maxSlideReached, currentSlide);
  }
  broadcastSlideInfo();
}

function advanceSlide(delta) {
  if (!slidesData.length) return;
  setCurrentSlide(currentSlide + delta);
}

// Digita o numero do slide e Enter -- atalho nativo do PowerPoint/Prezi em
// modo apresentacao pra pular direto pra um slide especifico.
function jumpToSlideOnScreen(targetIndex) {
  String(targetIndex)
    .split('')
    .forEach((digit) => robot.keyTap(digit));
  robot.keyTap('enter');
}

function executeCommand(cmd, msg) {
  const viaOffice = usingOffice();
  switch (cmd) {
    case 'next':
      if (viaOffice) { office.send({ cmd: 'ppt.next' }); break; }
      robot.keyTap('right');
      advanceSlide(1);
      break;
    case 'prev':
      if (viaOffice) { office.send({ cmd: 'ppt.prev' }); break; }
      robot.keyTap('left');
      advanceSlide(-1);
      break;
    case 'first':
      if (viaOffice) office.send({ cmd: 'ppt.first' });
      else { robot.keyTap('home'); setCurrentSlide(1); }
      break;
    case 'last':
      if (viaOffice) office.send({ cmd: 'ppt.last' });
      else { robot.keyTap('end'); setCurrentSlide(slidesData.length); }
      break;
    case 'white':
      if (viaOffice) office.send({ cmd: 'ppt.white' });
      else robot.keyTap('w');
      break;
    case 'goto': {
      const target = Number(msg?.index);
      const total = totalSlides();
      if (!total || !Number.isInteger(target)) break;
      const clamped = Math.max(1, Math.min(total, target));
      if (viaOffice) { office.send({ cmd: 'ppt.goto', index: clamped }); break; }
      jumpToSlideOnScreen(clamped);
      setCurrentSlide(clamped);
      break;
    }
    case 'start':
      if (viaOffice) {
        office.send({ cmd: 'ppt.start', fromCurrent: !!msg?.fromCurrent, index: officeState.ppt.current });
      } else {
        if (msg?.fromCurrent) robot.keyTap('f5', ['shift']); else robot.keyTap('f5');
        if (slidesData.length) {
          currentSlide = 1;
          broadcastSlideInfo();
        }
      }
      beginSessionHistory();
      break;
    case 'end':
      if (viaOffice) office.send({ cmd: 'ppt.end' });
      else robot.keyTap('escape');
      laserActive = false;
      endSessionHistory();
      break;
    case 'black':
      if (viaOffice) office.send({ cmd: 'ppt.black' });
      else robot.keyTap('b');
      break;
    case 'laser-on':
      if (!laserActive) {
        robot.keyToggle('control', 'down');
        robot.keyTap('l');
        robot.keyToggle('control', 'up');
        laserActive = true;
      }
      break;
    case 'laser-off':
      if (laserActive) {
        robot.keyToggle('control', 'down');
        robot.keyTap('l');
        robot.keyToggle('control', 'up');
        laserActive = false;
      }
      break;
    default:
      console.log('Comando desconhecido:', cmd);
  }
}

// Limite de deslocamento por mensagem -- so proteje contra uma mensagem
// malformada/absurda causar um salto gigante do cursor, nao contra uso
// normal do touchpad (que manda valores bem menores que isso).
const MAX_MOUSE_DELTA = 2000;


// Sem robotjs (ex.: bloqueado pelo Smart App Control do Windows, que nao aceita
// modulos nativos sem assinatura), usa o PowerShell: SendKeys + mouse_event.
function createWindowsInputShim(cause) {
  try {
    const fsX = require('fs');
    const osX = require('os');
    const cp = require('child_process');
    const script = path.join(osX.tmpdir(), 'imago-input-bridge.ps1');
    const externalScript = path.join(path.dirname(process.execPath), 'input-bridge.ps1');
    const bundledScript = path.join(__dirname, 'input-bridge.ps1');
    const sourceScript = process.pkg && fsX.existsSync(externalScript) ? externalScript : bundledScript;
    fsX.writeFileSync(script, fsX.readFileSync(sourceScript));
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.on('error', (e) => console.log('[Erro] PowerShell nao iniciou:', e.message));
    child.stderr.on('data', (d) => console.log('[input]', String(d).trim()));
    process.on('exit', () => { try { child.kill(); } catch { /* ja encerrou */ } });
    console.log('[Aviso] robotjs indisponivel (' + String(cause.message).split('\n')[0] + ').');
    console.log('        Usando o modo PowerShell para teclado e mouse.');
    const send = (o) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n'); };
    const KEYS = { right: '{RIGHT}', left: '{LEFT}', home: '{HOME}', end: '{END}', f5: '{F5}', escape: '{ESC}', enter: '{ENTER}' };
    let ctrl = false;
    return {
      relative: true,
      keyTap(k, mods = []) {
        let s = KEYS[k] || k;
        if (mods.includes('shift')) s = '+' + s;
        if (ctrl || mods.includes('control')) s = '^' + s;
        send({ k: s });
      },
      keyToggle(k, state) { if (k === 'control') ctrl = state === 'down'; },
      mouseMove(dx, dy) { send({ mv: 1, dx: Math.round(dx), dy: Math.round(dy) }); },
      mouseClick() { send({ ck: 1 }); },
    };
  } catch {
    return null;
  }
}

function moveMouseRelative(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const clampedDx = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dx));
  const clampedDy = Math.max(-MAX_MOUSE_DELTA, Math.min(MAX_MOUSE_DELTA, dy));
  if (robot.relative) { robot.mouseMove(clampedDx, clampedDy); return; }
  const pos = robot.getMousePos();
  const screen = robot.getScreenSize();
  const x = Math.max(0, Math.min(screen.width, pos.x + clampedDx));
  const y = Math.max(0, Math.min(screen.height, pos.y + clampedDy));
  robot.moveMouse(x, y);
}

function handleIncoming(msg, ws) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'command') executeCommand(msg.command, msg);
  else if (msg.type === 'move') moveMouseRelative(msg.dx, msg.dy);
  else if (msg.type === 'click') robot.mouseClick();
  else if (msg.type === 'get-history') sendHistoryTo(ws);
  else if (msg.type === 'office') office.fromPhone(msg);
}

// Manda o estado atual (slide corrente, status das miniaturas e as
// miniaturas ja prontas) pra uma conexao que acabou de abrir ou reconectar.
function syncNewConnection(ws) {
  if (officeState) safeSend(ws, JSON.stringify({ type: 'office-state', ...officeState }));
  if (officeSlides) safeSend(ws, JSON.stringify({ type: 'office-slides', ...officeSlides }));
  broadcastSlideInfo();
  sendThumbsStatusTo(ws);
  sendCachedThumbsTo(ws);
}

// ---------- 1) Servidor local para conexao direta via Wi-Fi/offline ----------
// Isso e impresso assim que o servidor local abre, SEM esperar o relay --
// se nao fizer isso, quem estiver 100% offline (ou esperando o relay
// "acordar", que em planos gratuitos como o Render pode levar ~1 minuto)
// nunca veria o QR code, mesmo estando na mesma rede Wi-Fi.
let lastRelayCode = null;

// O proprio Imago serve a tela do celular pela rede local (HTTP na mesma porta
// do WebSocket). Isso e o que faz o Wi-Fi funcionar a partir do navegador: uma
// pagina HTTPS (GitHub Pages) NAO pode abrir ws:// (conteudo misto bloqueado
// pelo Chrome/Safari), mas uma pagina http:// do proprio PC pode. Serve so a
// lista fixa abaixo -- nada de ler arquivos arbitrarios do disco.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/capacitor.js': ['capacitor.js', 'application/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
  '/version.json': ['version.json', 'application/json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

const localHttp = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://imago.local').pathname;
  } catch { /* URL invalida: cai no 404 abaixo */ }
  const entry = Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname) ? STATIC_FILES[pathname] : null;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nao encontrado');
    return;
  }
  let body;
  try {
    body = fs.readFileSync(path.join(__dirname, entry[0]));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Arquivo do app nao encontrado neste Imago.');
    return;
  }
  res.writeHead(200, {
    'Content-Type': entry[1],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

// maxPayload evita que uma conexao mande mensagens gigantes de proposito
// (nenhum comando legitimo do app precisa de mais que alguns KB).
localWss = new WebSocketServer({ server: localHttp, maxPayload: 65536 });
localHttp.listen(LOCAL_PORT, '0.0.0.0');
localWss.on('listening', () => {
  printConnectionInfo(lastRelayCode);
});
localWss.on('error', (err) => {
  console.log(`[Erro] Nao consegui abrir o servidor local na porta ${LOCAL_PORT}: ${err.message}`);
  console.log('       Verifique se ja ha outro Imago aberto, ou troque a porta com a variavel LOCAL_PORT.');
});
localWss.on('connection', (ws) => {
  // Sem um handler de 'error', um frame invalido ou uma mensagem maior que o
  // maxPayload vira excecao nao tratada e derruba o Imago (bastava um aparelho
  // qualquer da rede para isso, sem nem autenticar).
  ws.on('error', () => {});

  // Toda conexao comeca NAO autenticada -- so vira "o celular" depois de
  // mandar {type:'hello', token} com o codigo de seguranca certo. Sem isso,
  // qualquer aparelho na mesma rede Wi-Fi conseguiria controlar a
  // apresentacao so por saber o IP/porta, sem nunca ter escaneado o QR.
  ws.authorized = false;
  const authTimeout = setTimeout(() => {
    if (!ws.authorized) ws.close(4001, 'tempo esgotado para autenticar');
  }, 8000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignora mensagem invalida
    }
    // JSON valido mas que nao e objeto (null, 42, "x"): msg.type explodiria.
    if (!msg || typeof msg !== 'object') return;

    if (!ws.authorized) {
      if (msg.type === 'hello' && safeEqual(msg.token, SESSION_TOKEN)) {
        ws.authorized = true;
        clearTimeout(authTimeout);
        console.log('[Local] Celular conectado e autenticado pela rede local.');
        ws.send(JSON.stringify({ type: 'hello-ok' }));
        syncNewConnection(ws);
      } else {
        console.log('[Local] Conexao recusada: codigo de seguranca invalido.');
        ws.close(4003, 'codigo de seguranca invalido');
      }
      return;
    }

    handleIncoming(msg, ws);
  });
  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (ws.authorized) console.log('[Local] Celular desconectou.');
  });
});

// ---------- 2) Conexao com o relay para uso via dados moveis ----------
function connectRelay() {
  if (RELAY_NOT_CONFIGURED) {
    if (!relayConfigWarningShown) {
      relayConfigWarningShown = true;
      console.log('[Relay] Dados móveis desativados: configure RELAY_URL para usar internet. Wi-Fi local continua disponível.');
    }
    return;
  }
  if (relayRetryTimer) {
    clearTimeout(relayRetryTimer);
    relayRetryTimer = null;
  }

  let relayWs;
  try {
    relayWs = new WebSocket(RELAY_URL, { maxPayload: 65536 });
  } catch (err) {
    console.log(`[Relay] URL inválida ou relay indisponível: ${err.message}`);
    scheduleRelayRetry();
    return;
  }

  relayWs.on('open', () => {
    relayRetryDelayMs = 5000;
    relayWs.send(JSON.stringify({ type: 'register-pc' }));
  });

  relayWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'session-created') {
      currentRelayWs = relayWs;
      lastRelayCode = msg.code;
      console.log(`[Relay] Pronto para dados moveis -- codigo: ${msg.code}`);
      printConnectionInfo(lastRelayCode);
    } else if (msg.type === 'phone-connected') {
      // O codigo do relay so garante que o celular achou a sessao certa --
      // ainda falta confirmar que ele tambem tem o codigo de seguranca
      // (do QR/tela do PC) antes de mandar qualquer coisa sensivel ou
      // aceitar comandos. Ver bloco "hello" abaixo.
      relayAuthorized = false;
      console.log('[Relay] Celular conectou pela internet -- aguardando autenticacao...');
    } else if (msg.type === 'phone-disconnected') {
      relayAuthorized = false;
      console.log('[Relay] Celular desconectou.');
    } else if (!relayAuthorized) {
      if (msg.type === 'hello' && safeEqual(msg.token, SESSION_TOKEN)) {
        relayAuthorized = true;
        console.log('[Relay] Celular autenticado.');
        relayWs.send(JSON.stringify({ type: 'hello-ok' }));
        syncNewConnection(relayWs);
      } else {
        console.log('[Relay] Mensagem ignorada: celular ainda nao autenticado (codigo de seguranca invalido ou ausente).');
      }
    } else {
      handleIncoming(msg, relayWs);
    }
  });

  relayWs.on('close', () => {
    if (currentRelayWs === relayWs) currentRelayWs = null;
    relayAuthorized = false;
    scheduleRelayRetry();
  });

  relayWs.on('error', () => {
    // 'close' tambem sera chamado em seguida, a reconexao acontece la
  });
}

function scheduleRelayRetry() {
  if (RELAY_NOT_CONFIGURED || relayRetryTimer) return;
  const delay = relayRetryDelayMs;
  relayRetryDelayMs = Math.min(Math.round(relayRetryDelayMs * 1.8), 120000);
  console.log(`[Relay] Indisponível. Nova tentativa em ${Math.ceil(delay / 1000)}s; Wi-Fi local continua funcionando.`);
  relayRetryTimer = setTimeout(() => {
    relayRetryTimer = null;
    connectRelay();
  }, delay);
  relayRetryTimer.unref?.();
}

function printConnectionInfo(relayCode) {
  const ips = network.listLocalIps();
  const ip = ips.length ? ips[0].address : '127.0.0.1';
  const code = relayCode || '----';
  const query = `ip=${ip}&port=${LOCAL_PORT}&token=${SESSION_TOKEN}${relayCode ? `&code=${relayCode}` : ''}`;
  // O QR aponta para o proprio PC: abre na hora, funciona sem internet e sem o
  // bloqueio de conteudo misto do navegador. O link do site publicado serve
  // para quem esta em dados moveis (precisa do relay).
  const localUrl = `http://${ip}:${LOCAL_PORT}/?${query}`;
  const webUrl = `${WEB_APP_URL.replace(/\/$/, '')}/?${query}`;

  console.log('\n=== Imago - Controle Remoto de Apresentacao ===');
  console.log(`Rede local (Wi-Fi/offline): ws://${ip}:${LOCAL_PORT}`);
  if (ips.length > 1) {
    console.log(`Outros enderecos deste PC:  ${ips.slice(1).map((i) => i.address).join(', ')}  (se o QR nao abrir, troque o IP no celular)`);
  }
  console.log(`Codigo para dados moveis:   ${code}${relayCode ? '' : RELAY_NOT_CONFIGURED ? ' (relay nao configurado)' : ' (aguardando conexao com o relay...)'}`);
  console.log(`Codigo de seguranca:        ${SESSION_TOKEN}  (muda toda vez que o Imago abre; so quem tem o QR/link ou digita esse codigo consegue controlar)`);
  if (slidesData.length) {
    console.log(`Notas/titulos carregados de: ${PPTX_PATH} (${slidesData.length} slides)`);
  } else {
    console.log('Nenhuma apresentacao configurada -- rodando so com navegacao (sem notas/miniaturas).');
  }
  console.log(`\nAbra no celular (mesma rede Wi-Fi) ou escaneie o QR code abaixo:\n${localUrl}\n`);
  qrcode.generate(localUrl, { small: true });
  if (relayCode) console.log(`\nPara usar por dados moveis, abra:\n${webUrl}`);
  console.log('\nDeixe esta janela aberta durante toda a apresentacao.\n');
}

// ---------- Ponte com o Office (Windows) ----------
office.on('error', (err) => console.log('[Office] Aviso:', err.message));
office.on('ready', () => console.log('[Office] Ponte COM ativa: o Imago le o PowerPoint/Word/Excel abertos.'));
office.on('state', (msg) => {
  const prevSlide = usingOffice() ? officeState.ppt.current : null;
  const prevApp = officeState?.app;
  officeState = msg;
  const { type, ...rest } = msg;
  broadcast({ type: 'office-state', ...rest });
  if (usingOffice()) {
    const p = msg.ppt;
    if (p.current !== prevSlide || prevApp !== 'powerpoint') broadcastSlideInfo();
    if (activeSession) activeSession.maxSlideReached = Math.max(activeSession.maxSlideReached, p.current);
    // Apresentou pelo proprio PC? Registra no historico do mesmo jeito.
    if (p.inShow && !activeSession) beginSessionHistory();
    if (!p.inShow && activeSession) endSessionHistory();
  }
});
office.on('slides', (msg) => {
  officeSlides = msg;
  thumbsCache.clear();
  thumbsAvailable = true;
  thumbsReason = null;
  thumbsGenerating = true;
  const { type, ...rest } = msg;
  broadcast({ type: 'office-slides', ...rest });
  broadcastThumbsStatus();
  office.send({ cmd: 'thumbs', width: 400, indices: msg.slides.map((s) => s.i) });
});
office.on('thumb', (msg) => {
  const dataUrl = 'data:image/jpeg;base64,' + msg.data;
  thumbsCache.set(msg.index, dataUrl);
  broadcast({ type: 'slide-thumb', index: msg.index, total: totalSlides(), dataUrl });
  if (officeSlides && thumbsCache.size >= officeSlides.total) {
    thumbsGenerating = false;
    broadcastThumbsStatus();
  }
});
if (office.isSupported()) office.start();
process.on('exit', () => office.stop());

webBle = webBleBridge.start({
  token: SESSION_TOKEN,
  onMessage: (msg) => handleIncoming(msg, null),
  onConnect: () => {
    broadcastSlideInfo();
    broadcastThumbsStatus();
  },
  log: (message) => console.log(message),
});

connectRelay();
// Com a ponte COM (Windows) as miniaturas vem do proprio PowerPoint; o
// caminho LibreOffice+Poppler fica so para macOS/Linux.
if (!office.isSupported()) startThumbnailGeneration();
updater.checkForUpdate({ manifestUrl: UPDATE_MANIFEST_URL, currentVersion: CURRENT_VERSION });
if (!RELAY_NOT_CONFIGURED) console.log('Conectando ao relay (modo dados moveis)... a rede local abre em seguida.');

// ---------- Encerramento: aplica atualizacao pendente (se houver) ----------
// Cobre tanto fechar a janela do terminal (SIGINT/Ctrl+C, tratado como
// "encerrar" -- ver history em modules.js) quanto process.exit chamado por outro
// caminho. So dispara o processo de atualizacao, nao trava o fechamento.
let updateHandled = false;
function handleExit() {
  if (updateHandled) return;
  updateHandled = true;
  updater.launchApplyIfReady();
}
process.on('exit', handleExit);
process.on('SIGINT', () => {
  handleExit();
  process.exit(0);
});
process.on('SIGTERM', () => {
  handleExit();
  process.exit(0);
});
