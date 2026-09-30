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

console.log(`\n${passed} teste(s) passaram.`);
