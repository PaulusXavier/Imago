// Teste de integração do relay-server.js: sobe o servidor de verdade e conecta um
// "PC" e um "celular" falsos por WebSocket. Rode com: npm test (precisa de "npm ci").
const assert = require('assert');
const net = require('net');
const path = require('path');
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

// Cliente que guarda tudo o que recebe e deixa esperar por uma mensagem.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.match(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
      else inbox.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        inbox,
        send: (o) => ws.send(JSON.stringify(o)),
        next(match = () => true, ms = 3000) {
          const i = inbox.findIndex(match);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('tempo esgotado esperando mensagem')), ms);
            waiters.push({ match, resolve: (m) => { clearTimeout(t); res(m); } });
          });
        },
      })
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = await freePort();
  const relay = spawn(process.execPath, [path.join(__dirname, 'relay-server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    relay.stdout.on('data', (d) => String(d).includes('Relay rodando') && resolve());
    relay.on('exit', () => reject(new Error('relay encerrou antes de iniciar')));
    setTimeout(() => reject(new Error('relay nao iniciou a tempo')), 8000);
  });
  const url = `ws://127.0.0.1:${port}`;

  console.log('== relay-server.js (integração) ==');
  let pc;
  let phone;
  let code;

  await test('PC registra e recebe um código de 6 dígitos', async () => {
    pc = await connect(url);
    pc.send({ type: 'register-pc' });
    const msg = await pc.next((m) => m.type === 'session-created');
    assert.match(msg.code, /^\d{6}$/);
    code = msg.code;
  });

  await test('celular com código errado recebe erro', async () => {
    const bad = await connect(url);
    bad.send({ type: 'join', code: '000000' });
    const msg = await bad.next((m) => m.type === 'error');
    assert.ok(msg.message);
    bad.ws.close();
  });

  await test('celular com o código certo entra e o PC é avisado', async () => {
    phone = await connect(url);
    phone.send({ type: 'join', code });
    await phone.next((m) => m.type === 'joined');
    await pc.next((m) => m.type === 'phone-connected');
  });

  await test('mensagens comuns são repassadas nos dois sentidos', async () => {
    phone.send({ type: 'hello', token: 'ABC' });
    const got = await pc.next((m) => m.type === 'hello');
    assert.strictEqual(got.token, 'ABC');
    pc.send({ type: 'hello-ok' });
    await phone.next((m) => m.type === 'hello-ok');
    phone.send({ type: 'command', command: 'next' });
    assert.strictEqual((await pc.next((m) => m.type === 'command')).command, 'next');
  });

  await test('celular NÃO consegue se passar pelo relay (tipos reservados são descartados)', async () => {
    phone.send({ type: 'phone-disconnected' });
    phone.send({ type: 'session-created', code: '999999' });
    phone.send({ type: 'pc-disconnected' });
    phone.send({ type: 'command', command: 'marcador' }); // esta, sim, deve chegar
    const got = await pc.next((m) => m.type === 'command' && m.command === 'marcador');
    assert.ok(got);
    await sleep(100);
    const indevidas = pc.inbox.filter((m) =>
      ['phone-disconnected', 'session-created', 'pc-disconnected'].includes(m.type)
    );
    assert.deepStrictEqual(indevidas, []);
  });

  await test('PC também não repassa tipos reservados ao celular', async () => {
    pc.send({ type: 'error', message: 'falso' });
    pc.send({ type: 'slide-info', index: 1, total: 3 });
    await phone.next((m) => m.type === 'slide-info');
    assert.deepStrictEqual(phone.inbox.filter((m) => m.type === 'error'), []);
  });

  await test('sem JSON válido a conexão continua funcionando', async () => {
    phone.ws.send('isso não é json');
    phone.ws.send('null');
    phone.send({ type: 'command', command: 'depois-do-lixo' });
    assert.ok(await pc.next((m) => m.command === 'depois-do-lixo'));
  });

  await test('quando o PC cai, o celular é avisado e desconectado', async () => {
    const closed = new Promise((r) => phone.ws.once('close', r));
    pc.ws.close();
    await phone.next((m) => m.type === 'pc-disconnected');
    await closed;
  });

  await test('limite de conexoes NAO pode ser burlado forjando o X-Forwarded-For', async () => {
    // Um proxy confiavel acrescenta o IP real (9.9.9.9) NO FIM; o que o cliente
    // escreve antes disso (aqui, um IP diferente a cada tentativa) deve ser ignorado.
    const codes = [];
    for (let i = 0; i < 25; i++) {
      const code = await new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: { 'X-Forwarded-For': `1.2.3.${i}, 9.9.9.9` } });
        ws.on('error', () => resolve('erro'));
        ws.on('close', (c) => resolve(c));
        ws.on('open', () => setTimeout(() => ws.close(1000), 50));
      });
      codes.push(code);
    }
    assert.ok(codes.includes(4029), `nenhuma conexao foi limitada: ${codes.join(',')}`);
    // Quem NAO passa por proxy (sem header) continua com o seu proprio limite.
    const other = await connect(url).catch(() => null);
    assert.ok(other, 'conexao sem header deveria continuar aceita');
    other.ws.close();
  });

  relay.kill();
  console.log(`\n${passed} teste(s) do relay passaram.`);
})().catch((err) => {
  console.error('FALHA no teste do relay:', err);
  process.exit(1);
});
