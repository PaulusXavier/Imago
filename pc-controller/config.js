// Guarda a configuração do Imago (principalmente qual apresentação usar)
// num arquivo config.json ao lado do programa -- assim ninguém precisa abrir
// e editar código pra usar o app no dia a dia, só rodar o setup uma vez (ou
// arrastar o .pptx em cima do atalho).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Quando empacotado com "pkg" (veja README > Gerar o instalável), o programa
// vira um único .exe e o "process.pkg" existe. Nesse caso o config.json tem
// que ficar do lado do .exe (pasta real do disco), não dentro do pacote
// (que é só leitura). Rodando direto com "node controller.js" no
// desenvolvimento, fica do lado do próprio arquivo controller.js.
function baseDir() {
  return process.pkg ? path.dirname(process.execPath) : __dirname;
}

const CONFIG_PATH = path.join(baseDir(), 'config.json');

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function save(partialConfig) {
  const merged = { ...load(), ...partialConfig };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.log('[Aviso] Não foi possível salvar config.json:', err.message);
  }
  return merged;
}

// Procura arquivos .pptx nas pastas mais comuns do usuário (Área de
// Trabalho, Documentos, Downloads), pra sugerir automaticamente no setup
// sem precisar digitar ou copiar/colar caminho nenhum.
function findPptxCandidates() {
  const home = os.homedir();
  const folders = [
    path.join(home, 'Desktop'),
    path.join(home, 'Área de Trabalho'),
    path.join(home, 'Documents'),
    path.join(home, 'Documentos'),
    path.join(home, 'Downloads'),
  ];
  const seen = new Set();
  const found = [];
  for (const folder of folders) {
    let files;
    try {
      files = fs.readdirSync(folder);
    } catch {
      continue; // pasta não existe nesse sistema/idioma, ignora
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.pptx')) continue;
      const full = path.join(folder, file);
      if (seen.has(full)) continue;
      seen.add(full);
      found.push(full);
    }
  }
  return found;
}

module.exports = { load, save, findPptxCandidates, CONFIG_PATH, baseDir };
