// Teste de integração do controller.js: sobe o programa do PC de verdade (com um
// "robotjs" de mentira que só anota as teclas) e fala com ele por WebSocket/HTTP.
// Roda numa cópia temporária, então não mexe no config.json/histórico do projeto.
// Rode com: npm test (precisa de "npm ci").
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    process.exitCode = 1;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// Abre um WebSocket e devolve { ws, inbox, send, next, closed }.
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    const waiters = [];
    let closeInfo = null;
    const closedWaiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const w = waiters.findIndex((x) => x.match(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    });
    ws.on('close', (code) => { closeInfo = { code }; closedWaiters.splice(0).forEach((f) => f(closeInfo)); });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        inbox,
        send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
        next(match = () => true, ms = 4000) {
          const i = inbox.findIndex(match);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('tempo esgotado esperando mensagem')), ms);
            waiters.push({ match, resolve: (m) => { clearTimeout(t); res(m); } });
          });
        },
        closed(ms = 4000) {
          if (closeInfo) return Promise.resolve(closeInfo);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('conexão não foi fechada')), ms);
            closedWaiters.push((c) => { clearTimeout(t); res(c); });
          });
        },
      })
    );
  });
}

(async () => {
  // ---- cópia temporária do projeto (o controller grava config/histórico ao lado dele) ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imago-ctrl-test-'));
  const files = [
    'controller.js', 'modules.js', 'web-ble-bridge.js', 'package.json', 'office-bridge.ps1', 'input-bridge.ps1',
    'index.html', 'app.js', 'capacitor.js', 'manifest.json', 'version.json', 'icon.svg',
    'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  ];
  for (const f of files) fs.copyFileSync(path.join(__dirname, f), path.join(tmp, f));
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');

  // "robotjs" de mentira: anota cada tecla; e o Bluetooth opcional fica indisponível.
  const keysLog = path.join(tmp, 'keys.log');
  fs.writeFileSync(
    path.join(tmp, 'stub-robot.js'),
    `const Module = require('module');
const fs = require('fs');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'robotjs') {
    const log = (o) => fs.appendFileSync(${JSON.stringify(keysLog)}, JSON.stringify(o) + '\\n');
    return {
      keyTap: (k, mods) => log({ k, mods: mods || [] }),
      keyToggle: (k, s) => log({ toggle: k, s }),
      mouseClick: () => log({ click: 1 }),
      moveMouse: (x, y) => log({ mv: [x, y] }),
      getMousePos: () => ({ x: 100, y: 100 }),
      getScreenSize: () => ({ width: 1920, height: 1080 }),
    };
  }
  if (request === '@stoprocent/bleno') throw new Error('indisponivel no teste');
  return load.call(this, request, ...rest);
};
`
  );
  const keys = () =>
    fs.existsSync(keysLog)
      ? fs.readFileSync(keysLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, ['-r', './stub-robot.js', 'controller.js'], {
    cwd: tmp,
    env: { ...process.env, LOCAL_PORT: String(port), RELAY_URL: '', PPTX_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  const token = await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const m = out.match(/Codigo de seguranca:\s+([A-Z0-9]{10})/);
      if (m) { clearInterval(t); resolve(m[1]); }
    }, 50);
    setTimeout(() => { clearInterval(t); reject(new Error('controller não iniciou:\n' + out)); }, 10000);
  });

  console.log('== controller.js (integração) ==');

  await test('servidor local serve o app e recusa caminhos fora da lista', async () => {
    const home = await httpGet(port, '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.body.toString('utf8'), /<title>/i);
    assert.strictEqual(home.headers['x-content-type-options'], 'nosniff');
    for (const bad of ['/package.json', '/../package.json', '/config.json', '/controller.js', '/%2e%2e/package.json']) {
      assert.strictEqual((await httpGet(port, bad)).status, 404, `deveria negar ${bad}`);
    }
  });

  await test('código de segurança errado é recusado (4003) e nada é executado', async () => {
    const c = await connect(port);
    c.send({ type: 'hello', token: 'ERRADO0000' });
    c.send({ type: 'command', command: 'next' });
    assert.strictEqual((await c.closed()).code, 4003);
    assert.deepStrictEqual(keys(), []);
  });

  const phone = await connect(port);
  await test('código certo autentica (hello-ok) e recebe o estado', async () => {
    phone.send({ type: 'hello', token });
    await phone.next((m) => m.type === 'hello-ok');
    await phone.next((m) => m.type === 'thumbs-status');
  });

  await test('comandos viram teclas no PC (e "ir para slide" é ignorado sem .pptx configurado)', async () => {
    phone.send({ type: 'command', command: 'next' });
    phone.send({ type: 'command', command: 'prev' });
    phone.send({ type: 'command', command: 'goto', index: 12 }); // sem total de slides conhecido, nao faz nada
    await sleep(300);
    const taps = keys().map((k) => k.k);
    assert.deepStrictEqual(taps, ['right', 'left']);
  });

  await test('mensagens malformadas não derrubam o controller', async () => {
    phone.send('isto não é json');
    phone.send('null');
    phone.send('42');
    phone.send({ type: 'move', dx: 'abc', dy: null });
    phone.send({ type: 'command', command: 'nao-existe' });
    await sleep(200);
    assert.strictEqual(child.exitCode, null, 'o processo deveria continuar rodando');
    phone.send({ type: 'command', command: 'black' });
    await sleep(200);
    assert.strictEqual(keys().pop().k, 'b');
  });

  await test('movimento do touchpad é limitado e convertido em posição na tela', async () => {
    phone.send({ type: 'move', dx: 999999, dy: -999999 });
    await sleep(200);
    const mv = keys().filter((k) => k.mv).pop().mv;
    assert.deepStrictEqual(mv, [1920, 0]); // 100+2000 limita na largura da tela; 100-2000 limita em 0
  });

  await test('"Iniciar deste slide" usa Shift+F5 e "Iniciar" usa F5', async () => {
    phone.send({ type: 'command', command: 'start', fromCurrent: true });
    phone.send({ type: 'command', command: 'start' });
    await sleep(200);
    const f5 = keys().filter((k) => k.k === 'f5');
    assert.deepStrictEqual(f5.map((k) => k.mods), [['shift'], []]);
  });

  await test('histórico é devolvido ao pedir (e vem vazio antes da 1ª sessão)', async () => {
    phone.send({ type: 'get-history' });
    const h = await phone.next((m) => m.type === 'history');
    assert.ok(Array.isArray(h.sessions));
  });

  const ehWindows = process.platform === 'win32';
  await test(
    ehWindows ? 'encerramento salva a sessão (pulado no Windows: SIGTERM não existe lá)' : 'SIGTERM salva a sessão em andamento no histórico',
    async () => {
      if (ehWindows) return;
      // Os dois "Iniciar" acima: o 2º salva a sessão A e abre a B. Só a B depende do encerramento.
      child.kill('SIGTERM');
      const { code } = await exited;
      assert.strictEqual(code, 0);
      const histPath = path.join(tmp, 'session-history.json');
      assert.ok(fs.existsSync(histPath), 'session-history.json deveria ter sido criado');
      const list = JSON.parse(fs.readFileSync(histPath, 'utf8'));
      assert.strictEqual(list.length, 2, 'a sessão em andamento (B) também deveria ter sido salva ao encerrar');
      assert.ok(list[0].durationSec >= 0);
    }
  );

  if (child.exitCode === null) child.kill();
  await exited;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* arquivo em uso no Windows: o SO limpa depois */ }
  console.log(`\n${passed} teste(s) do controller passaram.`);
})().catch((err) => {
  console.error('FALHA no teste do controller:', err);
  process.exit(1);
});
