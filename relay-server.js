// Servidor relay - fica sempre online (ex: Render) e apenas repassa
// mensagens entre o "controlador" (script rodando no PC com o PowerPoint/Prezi)
// e o "celular" (a PWA aberta no navegador do celular).
//
// Fluxo:
//   1) O controlador do PC conecta e cria uma sessao com um codigo de 6 digitos.
//   2) O celular conecta e entra na mesma sessao usando esse codigo.
//   3) Qualquer mensagem enviada por um lado e repassada automaticamente pro outro.
//
// Nao guarda nada em disco: tudo fica em memoria e some quando os dois lados
// desconectam ou apos um tempo de inatividade.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SESSION_TTL_MS = 1000 * 60 * 60 * 4; // some depois de 4h sem uso
// Alem do codigo de 6 digitos (usado so pra achar a sessao certa), o app do
// PC exige um segundo segredo -- o "token" -- antes de aceitar qualquer
// comando (ver controller.js). O relay so faz o pareamento; nao valida o
// token, que e conferido ponta-a-ponta entre PC e celular.
const CODE_MIN = 100000;
const CODE_RANGE = 900000; // 6 digitos: 100000-999999
const MAX_SESSIONS = 500; // limite de sessoes simultaneas, evita esgotar memoria
const MAX_JOIN_ATTEMPTS_PER_CONN = 5; // tentativas de codigo por conexao antes de derrubar

// Tipos de mensagem que SO o relay pode gerar. Se o celular (que so precisa do codigo
// de 6 digitos para entrar) mandasse um deles, o PC trataria como se viesse do relay
// (ex.: fingir "phone-disconnected" ou "session-created"). Por isso nao sao repassados.
const RELAY_ONLY_TYPES = new Set([
  'session-created', 'joined', 'error', 'phone-connected', 'phone-disconnected', 'pc-disconnected',
]);

// sessions: codigo -> { pc: ws|null, phone: ws|null, lastActivity: number }
const sessions = new Map();

function makeCode() {
  let code;
  do {
    code = String(CODE_MIN + crypto.randomInt(CODE_RANGE));
  } while (sessions.has(code));
  return code;
}

function touch(session) {
  session.lastActivity = Date.now();
}

function cleanupLoop() {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      session.pc?.close();
      session.phone?.close();
      sessions.delete(code);
    }
  }
}
setInterval(cleanupLoop, 60_000).unref();

// ---------- Rate limiting simples por IP ----------
// So limita a taxa de NOVAS CONEXOES (o "handshake" de socket em si), pra
// dificultar um script tentando adivinhar codigos de 6 digitos em massa.
// E deliberadamente simples (memoria, sem dependencia externa) -- em troca
// de sobreviver a um restart do processo, o que e aceitavel aqui.
const CONNECTIONS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60_000;
const connectionCounts = new Map(); // ip -> { count, windowStart }
const MAX_TRACKED_IPS = 20000; // teto de memoria para a tabela acima

// Quantos proxies confiaveis (ex.: o balanceador do Render) ficam na frente do
// relay. Cada proxy ACRESCENTA no fim de X-Forwarded-For o IP de quem falou com
// ele; o que vem antes disso e escrito pelo proprio cliente e pode ser forjado.
// Por isso o IP real e contado a partir do FIM da lista, nunca do comeco.
// 0 = sem proxy (uso direto): o header e ignorado por completo.
const TRUST_PROXY_HOPS = (() => {
  const n = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 1;
})();

function clientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      // Lista menor que o esperado = alguem falou direto com o relay: nao da
      // para confiar em nada dela, entao cai no IP do proprio socket.
      if (parts.length >= TRUST_PROXY_HOPS) return parts[parts.length - TRUST_PROXY_HOPS].slice(0, 64);
    }
  }
  return req.socket.remoteAddress || 'desconhecido';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = connectionCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    if (connectionCounts.size >= MAX_TRACKED_IPS) connectionCounts.clear();
    connectionCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > CONNECTIONS_PER_WINDOW;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of connectionCounts.entries()) {
    if (now - entry.windowStart > RATE_WINDOW_MS) connectionCounts.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

// maxPayload: nenhuma mensagem legitima (comando, "hello", miniatura em
// base64) deveria chegar perto de 1MB -- evita abuso pra esgotar memoria/
// banda do relay gratuito.
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on('connection', (ws, req) => {
  let role = null; // 'pc' ou 'phone'
  let code = null;
  let joinAttempts = 0;
  const ip = clientIp(req);

  if (isRateLimited(ip)) {
    ws.close(4029, 'muitas conexoes, tente novamente em instantes');
    return;
  }

  // Sem um handler de 'error', qualquer erro do socket (ex.: mensagem maior que
  // maxPayload, frame invalido) vira excecao nao tratada e DERRUBA o relay
  // inteiro -- e um unico cliente malicioso ja conseguiria isso.
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignora mensagens que nao sao JSON valido
    }
    if (!msg || typeof msg !== 'object') return; // JSON valido mas nao e objeto (ex.: null, 42)

    // Primeira mensagem sempre define o papel da conexao
    if (!role) {
      if (msg.type === 'register-pc') {
        if (sessions.size >= MAX_SESSIONS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Relay ocupado no momento, tente novamente em instantes.' }));
          ws.close();
          return;
        }
        role = 'pc';
        code = makeCode();
        sessions.set(code, { pc: ws, phone: null, lastActivity: Date.now() });
        ws.send(JSON.stringify({ type: 'session-created', code }));
        return;
      }
      if (msg.type === 'join' && typeof msg.code === 'string') {
        joinAttempts += 1;
        if (joinAttempts > MAX_JOIN_ATTEMPTS_PER_CONN) {
          // Dificulta tentar varios codigos numa unica conexao (o rate
          // limit por IP ja dificulta abrir muitas conexoes novas).
          ws.close(4029, 'muitas tentativas de codigo');
          return;
        }
        const session = sessions.get(msg.code);
        if (!session || !session.pc) {
          ws.send(JSON.stringify({ type: 'error', message: 'Codigo invalido ou controlador nao esta online.' }));
          return;
        }
        if (session.phone) {
          // Ja existe um celular nessa sessao. Se ele ainda responde, nao
          // substituimos (evita "roubar" o controle so acertando o codigo).
          // Se ele caiu sem avisar (comum em dados moveis: o socket antigo
          // fica "aberto" ate o heartbeat perceber), a reconexao legitima do
          // mesmo celular ficava bloqueada por ~1 minuto. Por isso: mandamos
          // um ping no antigo agora; se nao vier o pong ate a proxima
          // tentativa (o app tenta de novo em 1-5s), ele e considerado morto
          // e a vaga e liberada.
          const old = session.phone;
          if (old.readyState === 1 && old.isAlive !== false) {
            old.isAlive = false;
            try { old.ping(); } catch { /* socket ja esta caindo */ }
            ws.send(JSON.stringify({ type: 'error', message: 'Ja ha um celular conectado a este codigo (tentando liberar a vaga, tente de novo).' }));
            return;
          }
          session.phone = null;
          try { old.terminate(); } catch { /* ja fechado */ }
        }
        role = 'phone';
        code = msg.code;
        session.phone = ws;
        touch(session);
        session.pc.send(JSON.stringify({ type: 'phone-connected' }));
        ws.send(JSON.stringify({ type: 'joined', code }));
        return;
      }
      // mensagem desconhecida antes de registrar papel: ignora
      return;
    }

    // Depois que o papel esta definido, apenas repassa pro outro lado
    if (RELAY_ONLY_TYPES.has(msg.type)) return;
    const session = sessions.get(code);
    if (!session) return;
    touch(session);
    const target = role === 'pc' ? session.phone : session.pc;
    if (target && target.readyState === 1) target.send(JSON.stringify(msg));
  });

  ws.on('close', () => {
    if (!code) return;
    const session = sessions.get(code);
    if (!session) return;
    if (role === 'pc') {
      if (session.pc !== ws) return;
      // Fecha de verdade a conexao do celular (nao so manda uma mensagem
      // avisando) -- assim o app do celular recebe um "close" de verdade e
      // aciona sozinho a logica de reconexao/tela de desconectado que ja
      // existe, em vez de ficar "conectado" pra sempre sem fazer nada.
      session.phone?.send(JSON.stringify({ type: 'pc-disconnected' }));
      session.phone?.close();
      sessions.delete(code);
    } else if (role === 'phone') {
      // So limpa a vaga se ainda for ESTE celular (apos uma troca, o 'close'
      // do celular antigo chega tarde e nao pode derrubar o novo).
      if (session.phone !== ws) return;
      session.phone = null;
      session.pc?.send(JSON.stringify({ type: 'phone-disconnected' }));
    }
  });

  // Mantem a conexao viva e detecta quedas que o SO/proxy nao avisa direito
  // (comum em provedores gratuitos como o Render, que podem derrubar
  // conexoes ociosas sem mandar um "close" correto).
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`Relay rodando na porta ${PORT}`);
});
