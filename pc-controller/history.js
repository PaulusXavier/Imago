// Guarda um historico simples das ultimas apresentacoes feitas com o Imago.
// Fica so no PC (arquivo local session-history.json, do lado do
// pc-controller) -- nao e enviado pra nenhum servidor. O app do celular pode
// pedir esses dados (aba "Historico") atraves da mensagem {type:'get-history'}.

const fs = require('fs');
const path = require('path');
const appConfig = require('./config');

// Mesma lógica do config.js: quando empacotado com "pkg", __dirname aponta
// pra dentro do executável (somente leitura), então o histórico precisa
// ficar do lado de fora, na pasta real do .exe no disco.
const HISTORY_PATH = path.join(appConfig.baseDir(), 'session-history.json');
const MAX_ENTRIES = 20;

function load() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(list, null, 2));
  } catch (err) {
    console.log('[Aviso] Nao foi possivel salvar o historico de sessoes:', err.message);
  }
}

/**
 * Cria o registro de uma nova sessao que esta comecando agora
 * (ex: quando o botao "Iniciar" e pressionado).
 */
function startSession({ slidesTotal, pptxName }) {
  return {
    startedAt: Date.now(),
    slidesTotal: slidesTotal || 0,
    maxSlideReached: slidesTotal ? 1 : 0,
    pptxName: pptxName || null,
  };
}

/**
 * Fecha uma sessao em andamento (ex: quando "Encerrar" e pressionado, ou o
 * script e interrompido) e salva no historico local.
 */
function finishAndSave(session) {
  const endedAt = Date.now();
  const entry = {
    startedAt: session.startedAt,
    endedAt,
    durationSec: Math.max(0, Math.round((endedAt - session.startedAt) / 1000)),
    slidesTotal: session.slidesTotal,
    maxSlideReached: session.maxSlideReached,
    pptxName: session.pptxName,
  };
  const list = load();
  list.unshift(entry);
  save(list.slice(0, MAX_ENTRIES));
  return entry;
}

function getRecent(n = 10) {
  return load().slice(0, n);
}

module.exports = { startSession, finishAndSave, getRecent };
