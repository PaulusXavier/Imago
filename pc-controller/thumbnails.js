// Gera miniaturas reais dos slides (imagem de cada slide, nao so titulo/notas).
//
// Como isso e mais pesado, usa duas ferramentas externas que precisam estar
// instaladas no PC (nao vem com o Node):
//   1) LibreOffice (comando "soffice") -- converte o .pptx em .pdf
//   2) Poppler (comando "pdftoppm")    -- converte o .pdf em uma imagem PNG por pagina
//
// Se qualquer uma delas nao estiver disponivel, as miniaturas simplesmente
// ficam desativadas e o resto do app (navegacao, notas, laser) continua
// funcionando normalmente -- so nao aparece a imagem do slide, so o texto.
//
// As imagens geradas ficam guardadas num cache local (pasta temporaria do
// sistema) e so sao refeitas se o arquivo .pptx mudar de tamanho/data.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SOFFICE_PATH = process.env.SOFFICE_PATH || 'soffice';
const PDFTOPPM_PATH = process.env.PDFTOPPM_PATH || 'pdftoppm';
// Largura maxima da miniatura em pixels -- suficiente pra tela de celular,
// mantendo o arquivo pequeno (rapido de mandar pelo Wi-Fi/relay).
const THUMB_MAX_SIZE = Number(process.env.THUMB_MAX_SIZE) || 420;

function toolExists(cmd) {
  try {
    const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    return !res.error;
  } catch {
    return false;
  }
}

function checkTools() {
  return {
    soffice: toolExists(SOFFICE_PATH),
    pdftoppm: toolExists(PDFTOPPM_PATH),
  };
}

function cacheDirFor(pptxPath) {
  const stat = fs.statSync(pptxPath);
  const key = crypto
    .createHash('md5')
    .update(`${pptxPath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex');
  return path.join(os.tmpdir(), 'imago-thumbs-cache', key);
}

function findExisting(dir, total) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  for (let i = 1; i <= total; i++) {
    const f = path.join(dir, `slide-${i}.png`);
    if (!fs.existsSync(f)) return null;
    files.push(f);
  }
  return files;
}

// Normaliza nomes tipo slide-01.png / slide-001.png (o pdftoppm usa
// zero-padding conforme o total de paginas) para slide-1.png, slide-2.png...
function normalizeNames(dir) {
  const produced = fs.readdirSync(dir).filter((f) => /^slide-\d+\.png$/.test(f));
  produced.forEach((f) => {
    const m = f.match(/^slide-0*(\d+)\.png$/);
    if (m && f !== `slide-${m[1]}.png`) {
      const target = path.join(dir, `slide-${m[1]}.png`);
      if (!fs.existsSync(target)) fs.renameSync(path.join(dir, f), target);
    }
  });
}

function toDataUrl(file) {
  const buf = fs.readFileSync(file);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Gera (ou reaproveita do cache) uma miniatura PNG por slide.
 * onSlideReady(index, dataUrl) e chamado conforme cada miniatura fica pronta.
 * onDone(ok, reason) e chamado no final ('reason' so importa quando ok=false).
 */
function generateThumbnails(pptxPath, totalSlides, onSlideReady, onDone) {
  const tools = checkTools();
  if (!tools.soffice || !tools.pdftoppm) {
    onDone(false, 'ferramentas-ausentes');
    return;
  }
  if (!totalSlides) {
    onDone(false, 'sem-slides');
    return;
  }

  let dir;
  try {
    dir = cacheDirFor(pptxPath);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    onDone(false, 'erro-cache');
    return;
  }

  const cached = findExisting(dir, totalSlides);
  if (cached) {
    cached.forEach((file, i) => {
      try {
        onSlideReady(i + 1, toDataUrl(file));
      } catch {
        /* ignora falha ao ler um arquivo do cache */
      }
    });
    onDone(true, null);
    return;
  }

  const soffice = spawn(SOFFICE_PATH, [
    '--headless',
    '--norestore',
    '--convert-to',
    'pdf',
    '--outdir',
    dir,
    pptxPath,
  ]);

  soffice.on('error', () => onDone(false, 'erro-soffice'));
  soffice.on('close', (code) => {
    const pdfPath = path.join(dir, `${path.basename(pptxPath, path.extname(pptxPath))}.pdf`);
    if (code !== 0 || !fs.existsSync(pdfPath)) {
      onDone(false, 'erro-soffice');
      return;
    }

    const prefix = path.join(dir, 'slide');
    const pdftoppm = spawn(PDFTOPPM_PATH, ['-png', '-scale-to', String(THUMB_MAX_SIZE), pdfPath, prefix]);

    pdftoppm.on('error', () => onDone(false, 'erro-pdftoppm'));
    pdftoppm.on('close', (code2) => {
      if (code2 !== 0) {
        onDone(false, 'erro-pdftoppm');
        return;
      }
      normalizeNames(dir);
      let anyFound = false;
      for (let i = 1; i <= totalSlides; i++) {
        const f = path.join(dir, `slide-${i}.png`);
        if (fs.existsSync(f)) {
          anyFound = true;
          try {
            onSlideReady(i, toDataUrl(f));
          } catch {
            /* ignora falha ao ler um slide especifico */
          }
        }
      }
      onDone(anyFound, anyFound ? null : 'nenhuma-imagem-gerada');
    });
  });
}

module.exports = { checkTools, generateThumbnails };
