// Atualização automática do Imago (app do PC).
//
// Como funciona, em resumo:
//   1) Toda vez que o Imago abre, este módulo busca um arquivo "version.json"
//      publicado na internet (por padrão, do lado da PWA no GitHub Pages --
//      veja WEB_APP_URL/UPDATE_MANIFEST_URL em controller.js) e compara com
//      a versão atual (a que está em package.json, embutida no .exe).
//   2) Se houver uma versão mais nova, baixa o .zip correspondente ao
//      sistema operacional em segundo plano, SEM interromper a apresentação
//      em andamento nem avisar nada na tela do celular.
//   3) A atualização baixada só é aplicada quando o Imago for fechado --
//      nesse momento um processo separado troca os arquivos e abre o Imago
//      de novo sozinho, já na versão nova. Isso evita trocar arquivos de um
//      programa que ainda está rodando (o que trava/falha, principalmente
//      no Windows) e evita atualizar no meio de uma apresentação.
//
// Publicando uma versão nova (veja também o README > "Publicando
// atualizações"): gere os instaláveis (npm run build:*), suba os .zips pra
// algum lugar com link direto (ex: "Releases" do GitHub) e atualize o
// version.json publicado com a nova versão + esses links.
//
// Isso só se aplica ao Imago já empacotado (.exe/.app gerado com "pkg") --
// rodando direto com "node controller.js" durante o desenvolvimento, a
// checagem é pulada (não existe um executável pra trocar).

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const AdmZip = require('adm-zip');
const appConfig = require('./config');

const UPDATE_DIR_NAME = '.imago-update';
const DOWNLOAD_TIMEOUT_MS = 20000;
// Quanto tempo, no máximo, o processo que aplica a atualização espera o
// Imago antigo fechar antes de desistir e trocar os arquivos mesmo assim.
const MAX_WAIT_FOR_EXIT_MS = 3 * 60 * 1000;
// Limites de tamanho -- só existem pra evitar que um manifesto/arquivo de
// atualização comprometido ou corrompido consuma memória/disco sem limite;
// um .zip normal do Imago (com robotjs nativo incluso) fica bem abaixo disso.
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024; // 300MB

function updateDir() {
  return path.join(appConfig.baseDir(), UPDATE_DIR_NAME);
}

function platformKey() {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// Compara duas versões tipo "1.2.0" -- retorna >0 se a e maior, <0 se b e
// maior, 0 se iguais. Não usa nenhuma lib de semver pra não adicionar mais
// uma dependência só pra isso.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Faz uma requisição HTTPS seguindo redirecionamentos (ex: link de
// "Releases" do GitHub redireciona pro arquivo de verdade). Resolve com a
// resposta ainda não lida -- quem chamou decide se lê tudo (JSON) ou faz
// stream pra um arquivo (download do .zip).
//
// Só HTTPS é aceito -- em qualquer redirecionamento também -- porque isso
// baixa e executa código no PC de quem apresenta; permitir HTTP abriria
// espaço pra um ataque de rede (MITM) trocar o instalável por outro.
function requestFollow(urlString, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlString);
    } catch {
      reject(new Error(`URL de atualização inválida: ${urlString}`));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`Atualização recusada: só é permitido usar HTTPS (recebido "${target.protocol}").`));
      return;
    }

    const req = https.get(target, { headers: { 'User-Agent': 'Imago-Updater' } }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // descarta o corpo do redirecionamento
        if (redirectsLeft <= 0) {
          reject(new Error('Muitos redirecionamentos ao buscar atualização.'));
          return;
        }
        let nextUrl;
        try {
          nextUrl = new URL(headers.location, target);
        } catch {
          reject(new Error('Redirecionamento inválido ao buscar atualização.'));
          return;
        }
        if (nextUrl.protocol !== 'https:') {
          reject(new Error('Atualização recusada: redirecionamento para fora de HTTPS.'));
          return;
        }
        requestFollow(nextUrl.toString(), redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} em ${urlString}`));
        return;
      }

      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('Tempo esgotado ao buscar atualização.')));
  });
}

async function fetchJson(urlString, maxBytes = MAX_MANIFEST_BYTES) {
  const res = await requestFollow(urlString);
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      throw new Error('Manifesto de atualização maior do que o esperado -- descartado por segurança.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Baixa pra um arquivo E calcula o SHA-256 dos bytes recebidos ao mesmo
// tempo (sem precisar ler o arquivo de novo depois) -- quem chamou compara
// esse hash com o do manifesto antes de considerar o download confiável.
async function downloadToFile(urlString, destPath, maxBytes = MAX_DOWNLOAD_BYTES) {
  const res = await requestFollow(urlString);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const hash = crypto.createHash('sha256');
  let total = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destPath);
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy(new Error('Download de atualização maior do que o esperado -- descartado por segurança.'));
        return;
      }
      hash.update(chunk);
    });
    res.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    res.pipe(fileStream);
  });

  return hash.digest('hex');
}

// Compara dois hashes SHA-256 (em hex) de forma segura contra ataques de
// timing -- o hash em si não é segredo, mas não custa nada fazer certo.
function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a.toLowerCase(), 'hex');
  const bufB = Buffer.from(b.toLowerCase(), 'hex');
  if (bufA.length !== 32 || bufB.length !== 32) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- Validação do manifesto (version.json) ----------
// Nunca confia cegamente no que veio da rede: um manifesto malformado,
// incompleto ou com tipos inesperados é simplesmente ignorado.
function isValidManifest(manifest) {
  return Boolean(
    manifest &&
      typeof manifest === 'object' &&
      typeof manifest.version === 'string' &&
      /^\d+\.\d+\.\d+$/.test(manifest.version) &&
      (manifest.notes === undefined || typeof manifest.notes === 'string') &&
      manifest.downloads &&
      typeof manifest.downloads === 'object'
  );
}

function isValidPlatformEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.url === 'string' &&
      entry.url.startsWith('https://') &&
      typeof entry.sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(entry.sha256)
  );
}

// Defesa extra contra "zip slip" (entradas do .zip com "../" tentando
// escrever fora da pasta de destino). As versões recentes do adm-zip já
// bloqueiam isso sozinhas, mas conferir de novo aqui não custa nada.
function assertSafeZipEntries(zip, destDir) {
  const destRoot = path.resolve(destDir);
  for (const entry of zip.getEntries()) {
    const resolved = path.resolve(destDir, entry.entryName);
    if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
      throw new Error(`Entrada suspeita no arquivo de atualização: "${entry.entryName}".`);
    }
  }
}

// Já existe uma atualização baixada e pronta (de uma checagem anterior) que
// ainda não foi aplicada, pra não baixar de novo toda vez que o Imago abre.
function alreadyDownloaded(version) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(updateDir(), 'pronto.json'), 'utf8'));
    return marker.version === version && fs.existsSync(path.join(updateDir(), 'extraido'));
  } catch {
    return false;
  }
}

// ---------- 1) Checagem + download em segundo plano (chamado ao abrir o Imago) ----------
async function checkForUpdate({ manifestUrl, currentVersion } = {}) {
  if (!process.pkg) {
    // Em desenvolvimento (node controller.js direto) não há .exe pra trocar.
    return;
  }
  if (!manifestUrl || manifestUrl.includes('SEU-USUARIO')) {
    // WEB_APP_URL ainda não foi configurado (veja aviso de RELAY_URL/WEB_APP_URL
    // já mostrado por controller.js) -- não faz sentido tentar checar.
    return;
  }

  try {
    const manifest = await fetchJson(manifestUrl);
    if (!isValidManifest(manifest)) {
      console.log('[Atualização] Manifesto de atualização com formato inesperado -- ignorando por segurança.');
      return;
    }

    const remoteVersion = manifest.version;
    if (compareVersions(remoteVersion, currentVersion) <= 0) {
      return; // já está na versão mais nova
    }

    if (alreadyDownloaded(remoteVersion)) {
      console.log(`[Atualização] Versão ${remoteVersion} já baixada -- será aplicada ao fechar o Imago.`);
      return;
    }

    const entry = manifest.downloads[platformKey()];
    if (!isValidPlatformEntry(entry)) {
      console.log(`[Atualização] Versão ${remoteVersion} disponível, mas sem link HTTPS + checksum válidos para este sistema (${platformKey()}) -- ignorando por segurança.`);
      return;
    }

    console.log(`[Atualização] Nova versão ${remoteVersion} disponível (atual: ${currentVersion}). Baixando em segundo plano...`);

    const dir = updateDir();
    // Limpa uma tentativa anterior incompleta/de outra versão antes de baixar.
    fs.rmSync(dir, { recursive: true, force: true });

    const zipPath = path.join(dir, 'atualizacao.zip');
    const extractedPath = path.join(dir, 'extraido');
    const actualHash = await downloadToFile(entry.url, zipPath);

    if (!hashesMatch(actualHash, entry.sha256)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('[Atualização] O arquivo baixado não confere com o checksum esperado (SHA-256) -- descartado por segurança. Nada foi alterado.');
      return;
    }

    const zip = new AdmZip(zipPath);
    assertSafeZipEntries(zip, extractedPath);
    zip.extractAllTo(extractedPath, true);
    fs.rmSync(zipPath, { force: true });

    // Confere que o pacote extraído realmente parece o Imago antes de
    // marcar como "pronto" -- evita aplicar (e travar a instalação) um
    // .zip que passou no checksum mas foi publicado por engano com outro
    // conteúdo.
    const expectedExe = process.platform === 'win32' ? 'Imago.exe' : 'Imago';
    if (!fs.existsSync(path.join(extractedPath, expectedExe))) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[Atualização] O pacote baixado não contém "${expectedExe}" -- descartado por segurança. Nada foi alterado.`);
      return;
    }

    fs.writeFileSync(
      path.join(dir, 'pronto.json'),
      JSON.stringify({ version: remoteVersion, notes: manifest.notes || '' }, null, 2)
    );

    console.log(`[Atualização] Versão ${remoteVersion} baixada e verificada (checksum ok) com sucesso.`);
    console.log('              Será aplicada automaticamente na próxima vez que o Imago for fechado e reaberto.');
  } catch (err) {
    // Nunca deixa um problema de rede/atualização derrubar o app -- a
    // apresentação em si não depende disso.
    console.log('[Atualização] Não foi possível checar/baixar atualizações agora:', err.message);
  }
}

// Chamado quando o Imago está encerrando (comando "end"/fechar janela) --
// se tiver uma atualização pronta, dispara o processo que vai trocar os
// arquivos, DESLIGADO deste processo (detached), pra sobreviver depois que
// o Imago atual sair.
function launchApplyIfReady() {
  if (!process.pkg) return;
  const dir = updateDir();
  const readyMarker = path.join(dir, 'pronto.json');
  const extractedPath = path.join(dir, 'extraido');
  if (!fs.existsSync(readyMarker) || !fs.existsSync(extractedPath)) return;

  try {
    const child = spawn(
      process.execPath,
      ['--aplicar-atualizacao', String(process.pid), appConfig.baseDir(), extractedPath],
      { detached: true, stdio: 'ignore', cwd: appConfig.baseDir() }
    );
    child.unref();
    console.log('[Atualização] Aplicando atualização em segundo plano -- o Imago vai reabrir sozinho em instantes.');
  } catch (err) {
    console.log('[Atualização] Não consegui iniciar a aplicação da atualização:', err.message);
  }
}

// ---------- 2) Aplicação da atualização (processo separado, "--aplicar-atualizacao") ----------
function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyPendingUpdate(argv) {
  // argv: [.., '--aplicar-atualizacao', pidAntigo, pastaDoApp, pastaExtraida]
  const idx = argv.indexOf('--aplicar-atualizacao');
  const oldPid = Number(argv[idx + 1]);
  const appDir = argv[idx + 2];
  const extractedPath = argv[idx + 3];

  console.log('[Atualização] Aguardando o Imago anterior fechar...');
  const start = Date.now();
  while (Number.isInteger(oldPid) && pidIsRunning(oldPid) && Date.now() - start < MAX_WAIT_FOR_EXIT_MS) {
    await wait(500);
  }
  // Pequena folga extra: no Windows o arquivo .exe pode continuar "preso"
  // por um instante mesmo depois do processo já ter saído.
  await wait(500);

  console.log('[Atualização] Copiando os arquivos novos...');
  fs.cpSync(extractedPath, appDir, { recursive: true, force: true });

  // No macOS/Linux o executável precisa continuar com permissão de execução
  // depois de copiado (o .zip às vezes não preserva isso).
  if (process.platform !== 'win32') {
    try {
      const exeName = fs.readdirSync(appDir).find((f) => f === 'Imago' || f.startsWith('Imago'));
      if (exeName) fs.chmodSync(path.join(appDir, exeName), 0o755);
    } catch {
      /* segue mesmo assim -- se falhar, o usuário so precisa reabrir manualmente */
    }
  }

  fs.rmSync(path.join(appDir, UPDATE_DIR_NAME), { recursive: true, force: true });

  console.log('[Atualização] Concluída. Reabrindo o Imago...');
  const exeName = process.platform === 'win32' ? 'Imago.exe' : 'Imago';
  const exePath = path.join(appDir, exeName);
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: appDir });
    child.unref();
  } catch (err) {
    console.log('[Atualização] Não consegui reabrir o Imago automaticamente:', err.message);
    console.log(`              Abra manualmente: ${exePath}`);
  }
}

module.exports = { checkForUpdate, launchApplyIfReady, applyPendingUpdate, compareVersions };
