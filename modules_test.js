// Testes do codigo REAL de modules.js (leitura do .pptx e escolha do IP).
// Diferente do logic_test.js, este importa as funcoes de verdade -- precisa de
// "npm ci" antes (adm-zip). Rode com: npm test
const assert = require('assert');
const AdmZip = require('adm-zip');
const { pptx, network } = require('./modules');

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

// ---------- .pptx sintetico com slides REORDENADOS ----------
// Na apresentacao a ordem e: slide2.xml, slide1.xml, slide3.xml.
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slideXml = (title, body) => `<p:sld ${NS}><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t xml:space="preserve">${title}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
const notesXml = (...paras) => `<p:notes ${NS}><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>2</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
const rels = (items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

function buildPptx() {
  const zip = new AdmZip();
  const add = (name, text) => zip.addFile(name, Buffer.from(text, 'utf8'));
  add('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId5"/><p:sldId id="258" r:id="rId9"/></p:sldIdLst></p:presentation>`);
  // Atributos em ordem diferente de proposito (Target antes de Id em um deles).
  add('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    <Relationship Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Id="rId7"/>
    <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide3.xml"/>
  </Relationships>`);
  add('ppt/slides/slide1.xml', slideXml('Segundo &amp; importante', 'corpo 1'));
  add('ppt/slides/slide2.xml', slideXml('Abertura', 'corpo 2'));
  add('ppt/slides/slide3.xml', slideXml('Fim &amp;lt;b&amp;gt; &#233;', 'corpo 3'));
  // Notas com numeracao que NAO bate com a do slide (notesSlide5 pertence ao slide1.xml).
  add('ppt/slides/_rels/slide1.xml.rels', rels([['rId1', 'notesSlide', '../notesSlides/notesSlide5.xml']]));
  add('ppt/notesSlides/notesSlide5.xml', notesXml('Primeira nota', 'Segunda nota'));
  add('ppt/slides/_rels/slide2.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  return zip;
}

console.log('== pptx.readSlides (modules.js) ==');
const slides = pptx.readSlides(buildPptx());
test('le os 3 slides', () => assert.strictEqual(slides.length, 3));
test('respeita a ordem do presentation.xml (nao o numero do arquivo)', () => {
  assert.deepStrictEqual(slides.map((s) => s.title), ['Abertura', 'Segundo & importante', 'Fim &lt;b&gt; \u00e9']);
});
test('titulo vem do marcador "title", nao do primeiro texto do slide', () => assert.strictEqual(slides[1].title, 'Segundo & importante'));
test('notas seguem o .rels do slide (notesSlide5 -> slide1.xml, que e o 2o da ordem)', () => assert.strictEqual(slides[1].notes, 'Primeira nota\nSegunda nota'));
test('nao descarta o primeiro paragrafo das notas nem inclui o numero do slide', () => {
  assert.ok(slides[1].notes.startsWith('Primeira nota'));
  assert.ok(!/\b2\b/.test(slides[1].notes));
});
test('slide sem notas fica com notas vazias', () => assert.strictEqual(slides[0].notes, ''));
test('&amp;lt; nao e decodificado duas vezes; entidade numerica funciona', () => assert.strictEqual(slides[2].title, 'Fim &lt;b&gt; \u00e9'));

test('sem presentation.xml cai na ordem numerica dos arquivos', () => {
  const z = new AdmZip();
  z.addFile('ppt/slides/slide10.xml', Buffer.from(slideXml('Dez', 'x')));
  z.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml('Dois', 'x')));
  assert.deepStrictEqual(pptx.readSlides(z).map((s) => s.title), ['Dois', 'Dez']);
});
test('slide sem nenhum texto vira "Slide N"', () => {
  const z = new AdmZip();
  z.addFile('ppt/slides/slide1.xml', Buffer.from(`<p:sld ${NS}><p:cSld><p:spTree/></p:cSld></p:sld>`));
  assert.strictEqual(pptx.readSlides(z)[0].title, 'Slide 1');
});

console.log('\n== network.listLocalIps (modules.js) ==');
const nic = (address, internal = false, family = 'IPv4') => [{ address, family, internal }];
test('ignora loopback e IPv6', () => {
  const list = network.listLocalIps({ lo: nic('127.0.0.1', true), Wi: [...nic('192.168.0.20'), ...nic('fe80::1', false, 'IPv6')] });
  assert.deepStrictEqual(list.map((i) => i.address), ['192.168.0.20']);
});
test('prefere a rede real a adaptadores virtuais (Hyper-V/WSL/VirtualBox)', () => {
  const best = network.bestLocalIp({
    'vEthernet (WSL)': nic('172.20.208.1'),
    'VirtualBox Host-Only Network': nic('192.168.56.1'),
    'Wi-Fi': nic('192.168.1.42'),
  });
  assert.strictEqual(best, '192.168.1.42');
});
test('sem adaptador real, ainda devolve o virtual (melhor que nada)', () => assert.strictEqual(network.bestLocalIp({ 'vEthernet (WSL)': nic('172.20.208.1') }), '172.20.208.1'));
test('aceita family numerico (Node 18.0-18.3 devolvia 4)', () => assert.strictEqual(network.bestLocalIp({ eth0: nic('10.0.0.7', false, 4) }), '10.0.0.7'));
test('sem rede nenhuma devolve 127.0.0.1', () => assert.strictEqual(network.bestLocalIp({}), '127.0.0.1'));

console.log(`\n${passed} teste(s) de modules.js passaram.`);
