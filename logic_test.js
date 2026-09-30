// Testes da lógica de segurança.
//  - Funções do atualizador: importadas do modules.js (código REAL, precisa de "npm ci").
//  - safeEqual / makeCode / generateSessionToken: ficam em controller.js e relay-server.js,
//    que abrem servidores ao serem carregados e por isso não podem ser importados aqui;
//    o teste usa uma CÓPIA delas -- se mudar lá, mude aqui também.
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { updater } = require('./modules');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('== compareVersions (modules.js > updater) ==');
const { compareVersions, hashesMatch, isValidManifest, isValidPlatformEntry } = updater;
test('1.2.0 > 1.1.0', () => assert.ok(compareVersions('1.2.0', '1.1.0') > 0));
test('1.1.0 == 1.1.0', () => assert.strictEqual(compareVersions('1.1.0', '1.1.0'), 0));
test('1.1.0 < 1.10.0 (nao trata como string)', () => assert.ok(compareVersions('1.1.0', '1.10.0') < 0));
test('1.0.0 < 1.0.1', () => assert.ok(compareVersions('1.0.0', '1.0.1') < 0));

console.log('\n== safeEqual (token, controller.js) ==');
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
test('token igual == true', () => assert.strictEqual(safeEqual('ABC123XYZ9', 'ABC123XYZ9'), true));
test('token diferente == false', () => assert.strictEqual(safeEqual('ABC123XYZ9', 'ABC123XYZ0'), false));
test('token de tamanho diferente nao lanca erro', () => assert.strictEqual(safeEqual('ABC', 'ABCDE'), false));
test('token undefined nao lanca erro', () => assert.strictEqual(safeEqual(undefined, 'ABC'), false));

console.log('\n== hashesMatch (SHA-256, modules.js > updater) ==');
const h1 = crypto.createHash('sha256').update('conteudo-a').digest('hex');
const h2 = crypto.createHash('sha256').update('conteudo-b').digest('hex');
test('hash igual (mesmo caso) == true', () => assert.strictEqual(hashesMatch(h1, h1), true));
test('hash igual (caixa alta) == true', () => assert.strictEqual(hashesMatch(h1, h1.toUpperCase()), true));
test('hash diferente == false', () => assert.strictEqual(hashesMatch(h1, h2), false));
test('hash malformado nao lanca erro', () => assert.strictEqual(hashesMatch('nao-e-hex', h1), false));
test('hash vazio == false', () => assert.strictEqual(hashesMatch('', ''), false));
test('hash com tamanho errado == false', () => assert.strictEqual(hashesMatch(h1.slice(0, 62), h1.slice(0, 62)), false));

console.log('\n== isValidManifest / isValidPlatformEntry (modules.js > updater) ==');
test('manifesto valido aceito', () =>
  assert.strictEqual(isValidManifest({ version: '1.2.0', downloads: {} }), true));
test('manifesto sem version rejeitado', () => assert.strictEqual(isValidManifest({ downloads: {} }), false));
test('manifesto com version nao-semver rejeitado', () =>
  assert.strictEqual(isValidManifest({ version: 'v1', downloads: {} }), false));
test('manifesto com notes de tipo errado rejeitado', () =>
  assert.strictEqual(isValidManifest({ version: '1.2.0', notes: 5, downloads: {} }), false));
test('manifesto null rejeitado', () => assert.strictEqual(isValidManifest(null), false));
test('manifesto string (injecao de tipo) rejeitado', () => assert.strictEqual(isValidManifest('1.2.0'), false));
test('entry https + sha256 valido aceito', () =>
  assert.strictEqual(isValidPlatformEntry({ url: 'https://x.com/a.zip', sha256: 'a'.repeat(64) }), true));
test('entry http (nao-https) rejeitado', () =>
  assert.strictEqual(isValidPlatformEntry({ url: 'http://x.com/a.zip', sha256: 'a'.repeat(64) }), false));
test('entry sha256 curto rejeitado', () =>
  assert.strictEqual(isValidPlatformEntry({ url: 'https://x.com/a.zip', sha256: 'abc' }), false));
test('entry sem sha256 rejeitado', () => assert.strictEqual(isValidPlatformEntry({ url: 'https://x.com/a.zip' }), false));

console.log('\n== assertSafeZipEntries (zip slip, modules.js > updater) ==');
const assertSafeZipEntries = (entries, destDir) =>
  updater.assertSafeZipEntries({ getEntries: () => entries }, destDir);
const dest = '/tmp/fake-extract-dir';
test('entradas normais passam', () => {
  assertSafeZipEntries([{ entryName: 'Imago.exe' }, { entryName: 'node_modules/robotjs/x.node' }], dest);
});
test('zip slip classico (../../etc/passwd) e bloqueado', () => {
  assert.throws(() => assertSafeZipEntries([{ entryName: '../../../etc/passwd' }], dest));
});
test('zip slip com caminho absoluto e bloqueado', () => {
  assert.throws(() => assertSafeZipEntries([{ entryName: '/etc/passwd' }], dest));
});
test('zip slip disfarcado (pasta/../../fora) e bloqueado', () => {
  assert.throws(() => assertSafeZipEntries([{ entryName: 'pasta/../../fora-da-pasta.txt' }], dest));
});

console.log('\n== makeCode (relay-server.js) — entropia e unicidade ==');
const CODE_MIN = 100000;
const CODE_RANGE = 900000;
function makeCode(existing) {
  let code;
  do {
    code = String(CODE_MIN + crypto.randomInt(CODE_RANGE));
  } while (existing.has(code));
  return code;
}
test('codigo sempre tem 6 digitos', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = makeCode(seen);
    assert.strictEqual(c.length, 6);
    seen.add(c);
  }
});
test('codigos gerados sao unicos (nao colidem com os ja existentes)', () => {
  const existing = new Set(['123456', '654321']);
  for (let i = 0; i < 200; i++) {
    const c = makeCode(existing);
    assert.ok(!['123456', '654321'].includes(c) || existing.size > 2);
  }
});

console.log('\n== generateSessionToken (controller.js) — alfabeto e tamanho ==');
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateSessionToken(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
  return out;
}
test('token tem o tamanho esperado e so usa o alfabeto sem ambiguos', () => {
  for (let i = 0; i < 200; i++) {
    const t = generateSessionToken();
    assert.strictEqual(t.length, 10);
    for (const ch of t) assert.ok(TOKEN_ALPHABET.includes(ch), `caractere fora do alfabeto: ${ch}`);
    assert.ok(!/[01OIL]/.test(t), `token com caractere ambiguo: ${t}`);
  }
});
test('dois tokens gerados nao sao iguais (entropia minima)', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.notStrictEqual(a, b);
});

console.log('\n== parseImagoLink (app.js) — link do QR code lido pela camera ==');
{
  // Usa o CODIGO REAL do app.js (extrai a funcao); "URL" ja existe no Node.
  const src = require('fs').readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf('function parseImagoLink');
  const b = src.indexOf('function applyConnectionLink');
  assert.ok(a > 0 && b > a, 'parseImagoLink nao encontrada no app.js');
  const parseImagoLink = new Function(`${src.slice(a, b)}; return parseImagoLink;`)();
  test('link do QR local traz ip, porta e codigo de seguranca (em maiusculas)', () => {
    const d = parseImagoLink('http://192.168.0.10:8765/?ip=192.168.0.10&port=8765&token=7k2qxm9f3p');
    assert.deepStrictEqual(d, { ip: '192.168.0.10', port: '8765', code: '', token: '7K2QXM9F3P' });
  });
  test('link com codigo do relay (dados moveis) e aceito', () => {
    const d = parseImagoLink('https://exemplo.github.io/imago/?ip=10.0.0.5&port=8765&token=ABC&code=123456');
    assert.strictEqual(d.code, '123456');
  });
  test('QR que nao e do Imago (texto, site sem ip/code) e recusado', () => {
    assert.strictEqual(parseImagoLink('WIFI:S:casa;T:WPA;P:senha;;'), null);
    assert.strictEqual(parseImagoLink('https://google.com/?q=oi'), null);
    assert.strictEqual(parseImagoLink(''), null);
    assert.strictEqual(parseImagoLink(undefined), null);
  });
  test('valores malformados no link sao recusados', () => {
    assert.strictEqual(parseImagoLink('http://x/?ip=a b<script>&token=A'), null);
    assert.strictEqual(parseImagoLink('http://x/?ip=10.0.0.1&port=99999&token=A'), null);
    assert.strictEqual(parseImagoLink('http://x/?code=12ab&token=A'), null);
    assert.strictEqual(parseImagoLink('javascript:alert(1)'), null);
  });
}

console.log('\n== notas pessoais por apresentacao (app.js) ==');
{
  const src = require('fs').readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf('let currentDeckKey');
  const b = src.indexOf('// ---------- Conexão ----------');
  assert.ok(a > 0 && b > a, 'bloco de notas nao encontrado no app.js');
  function makeNotes(initial = {}) {
    const store = new Map(Object.entries(initial));
    const window = { localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    } };
    const storageGet = (k) => window.localStorage.getItem(k);
    const storageSet = (k, v) => window.localStorage.setItem(k, v);
    const api = new Function('window', 'storageGet', 'storageSet',
      `${src.slice(a, b)}; return { set: (n) => { currentDeckKey = deckKeyFrom(n); }, key: notesKey, migrate: migrateLegacyNotes, deck: deckKeyFrom };`)(window, storageGet, storageSet);
    return { store, api };
  }
  test('mesmo numero de slide em apresentacoes diferentes nao compartilha nota', () => {
    const { api } = makeNotes();
    api.set('Aula 1.pptx'); const k1 = api.key(3);
    api.set('Prova.pptx'); const k2 = api.key(3);
    assert.notStrictEqual(k1, k2);
  });
  test('o nome e normalizado (maiusculas e extensao nao criam outra apresentacao)', () => {
    const { api } = makeNotes();
    assert.strictEqual(api.deck('Aula 1.PPTX'), api.deck('aula 1.pptx'));
    assert.strictEqual(api.deck('Aula 1.pptx'), api.deck('Aula 1'));
  });
  test('PC antigo (sem nome) continua na chave antiga', () => {
    const { api } = makeNotes();
    api.set('');
    assert.strictEqual(api.key(2), 'imago-notes-2');
  });
  test('notas antigas passam para a primeira apresentacao aberta e nao se repetem', () => {
    const { store, api } = makeNotes({ 'imago-notes-1': 'abertura', 'imago-notes-4': 'fechamento', 'imago-notes-size': '18' });
    api.set('Aula 1.pptx');
    api.migrate();
    assert.strictEqual(store.get(api.key(1)), 'abertura');
    assert.strictEqual(store.get(api.key(4)), 'fechamento');
    assert.ok(!store.has('imago-notes-1') && !store.has('imago-notes-4'));
    assert.strictEqual(store.get('imago-notes-size'), '18', 'nao pode mexer no tamanho da fonte das notas');
    api.set('Prova.pptx');
    api.migrate();
    assert.strictEqual(store.get(api.key(1)) ?? null, null, 'a segunda apresentacao nao herda as notas');
  });
}

console.log(`\n${passed} teste(s) passaram.`);
