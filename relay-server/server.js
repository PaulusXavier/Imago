// Servidor relay - fica sempre online (ex: Render) e apenas repassa
// mensagens entre o "controlador" (script rodando no PC com o PowerPoint/Prezi)
// e o "celular" (a PWA aberta no navegador do celular).
//
// Fluxo:
//   1) O controlador do PC conecta e cria uma sessao com um codigo de 4 digitos.
//   2) O celular conecta e entra na mesma sessao usando esse codigo.
//   3) Qualquer mensagem enviada por um lado e repassada automaticamente pro outro.
//
// Nao guarda nada em disco: tudo fica em memoria e some quando os dois lados
// desconectam ou apos um tempo de inatividade.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SESSION_TTL_MS = 1000 * 60 * 60 * 4; // some depois de 4h sem uso

// sessions: codigo -> { pc: ws|null, phone: ws|null, lastActivity: number }
const sessions = new Map();

function makeCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let role = null; // 'pc' ou 'phone'
  let code = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignora mensagens que nao sao JSON valido
    }

    // Primeira mensagem sempre define o papel da conexao
    if (!role) {
      if (msg.type === 'register-pc') {
        role = 'pc';
        code = makeCode();
        sessions.set(code, { pc: ws, phone: null, lastActivity: Date.now() });
        ws.send(JSON.stringify({ type: 'session-created', code }));
        return;
      }
      if (msg.type === 'join' && typeof msg.code === 'string') {
        const session = sessions.get(msg.code);
        if (!session || !session.pc) {
          ws.send(JSON.stringify({ type: 'error', message: 'Codigo invalido ou controlador nao esta online.' }));
          return;
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
    const session = sessions.get(code);
    if (!session) return;
    touch(session);
    const target = role === 'pc' ? session.phone : session.pc;
    target?.send(JSON.stringify(msg));
  });

  ws.on('close', () => {
    if (!code) return;
    const session = sessions.get(code);
    if (!session) return;
    if (role === 'pc') {
      // Fecha de verdade a conexao do celular (nao so manda uma mensagem
      // avisando) -- assim o app do celular recebe um "close" de verdade e
      // aciona sozinho a logica de reconexao/tela de desconectado que ja
      // existe, em vez de ficar "conectado" pra sempre sem fazer nada.
      session.phone?.send(JSON.stringify({ type: 'pc-disconnected' }));
      session.phone?.close();
      sessions.delete(code);
    } else if (role === 'phone') {
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
