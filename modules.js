// Modulos auxiliares do Imago (PC) reunidos em um unico arquivo:
// config, history, thumbnails, office, updater e setup.
// O controller.js importa tudo daqui.

// ==================== config ====================
const config = (() => {
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

  return { load, save, findPptxCandidates, CONFIG_PATH, baseDir };
})();

// ==================== history ====================
const history = (() => {
  // Guarda um historico simples das ultimas apresentacoes feitas com o Imago.
  // Fica so no PC (arquivo local session-history.json, do lado do
  // programa) -- nao e enviado pra nenhum servidor. O app do celular pode
  // pedir esses dados (aba "Historico") atraves da mensagem {type:'get-history'}.

  const fs = require('fs');
  const path = require('path');
  const appConfig = config;

  // Mesma lógica do config.js: quando empacotado com "pkg", __dirname aponta
  // pra dentro do executável (somente leitura), então o histórico precisa
  // ficar do lado de fora, na pasta real do .exe no disco.
  const HISTORY_PATH = path.join(appConfig.baseDir(), 'session-history.json');
  const MAX_ENTRIES = 20;

  function load() {
    try {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function save(list) {
    try {
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(list, null, 2));
    } catch (err) {
      console.log('[Aviso] Nao foi possivel salvar o historico de sessoes:', err.message);
    }
  }

  /**
   * Cria o registro de uma nova sessao que esta comecando agora
   * (ex: quando o botao "Iniciar" e pressionado).
   */
  function startSession({ slidesTotal, pptxName }) {
    return {
      startedAt: Date.now(),
      slidesTotal: slidesTotal || 0,
      maxSlideReached: slidesTotal ? 1 : 0,
      pptxName: pptxName || null,
    };
  }

  /**
   * Fecha uma sessao em andamento (ex: quando "Encerrar" e pressionado, ou o
   * script e interrompido) e salva no historico local.
   */
  function finishAndSave(session) {
    const endedAt = Date.now();
    const entry = {
      startedAt: session.startedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt - session.startedAt) / 1000)),
      slidesTotal: session.slidesTotal,
      maxSlideReached: session.maxSlideReached,
      pptxName: session.pptxName,
    };
    const list = load();
    list.unshift(entry);
    save(list.slice(0, MAX_ENTRIES));
    return entry;
  }

  function getRecent(n = 10) {
    return load().slice(0, n);
  }

  return { startSession, finishAndSave, getRecent };
})();

// ==================== thumbnails ====================
const thumbnails = (() => {
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

  return { checkTools, generateThumbnails };
})();

// ==================== office ====================
const office = (() => {
  // Ponte Node <-> PowerShell/COM (Windows). Sobe o office-bridge.ps1 como
  // processo filho e conversa por linhas JSON (stdin/stdout).
  //
  // Eventos: 'state', 'slides', 'thumb', 'ready', 'error'
  // Em macOS/Linux (ou sem PowerShell) nada acontece: isSupported() = false e o
  // controller continua usando so as teclas simuladas.

  const { spawn } = require('child_process');
  const EventEmitter = require('events');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const readline = require('readline');

  // Comandos que o celular pode repassar para a ponte (nada alem disso chega
  // ao PowerShell, mesmo com o token certo).
  const ALLOWED = new Set([
    'ppt.first', 'ppt.last', 'ppt.goto', 'ppt.toggleHidden', 'ppt.media', 'ppt.focus',
    'thumbs', 'refresh', 'select',
    'word.goto', 'word.comment', 'word.zoom', 'word.focus',
    'excel.sheet', 'excel.object', 'excel.zoom', 'excel.focus',
  ]);

  class OfficeBridge extends EventEmitter {
    constructor() {
      super();
      this.child = null;
      this.stopped = false;
      this.ready = false;
    }

    isSupported() {
      return process.platform === 'win32';
    }
    isRunning() {
      return !!this.child && this.ready;
    }

    start() {
      if (!this.isSupported() || this.child) return false;
      // Quando empacotado pelo "pkg" o .ps1 fica dentro do snapshot (nao da pra
      // executar dali) -- por isso copiamos pra pasta temporaria antes.
      let script;
      try {
        script = path.join(os.tmpdir(), 'imago-office-bridge.ps1');
        fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'office-bridge.ps1')));
      } catch (err) {
        this.emit('error', new Error('nao consegui preparar o office-bridge.ps1: ' + err.message));
        return false;
      }

      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      this.child = child;
      this.stopped = false;

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'ready') this.ready = true;
        this.emit(msg.type, msg);
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', (err) => {
        this.ready = false;
        this.child = null;
        this.emit('error', err);
      });
      child.on('exit', () => {
        this.ready = false;
        this.child = null;
        if (!this.stopped) setTimeout(() => this.start(), 3000);
      });
      return true;
    }

    stop() {
      this.stopped = true;
      try {
        this.child?.stdin.end();
        this.child?.kill();
      } catch {}
    }

    send(obj) {
      if (!this.child) return false;
      try {
        this.child.stdin.write(JSON.stringify(obj) + '\n');
        return true;
      } catch {
        return false;
      }
    }

    // Comando vindo do celular: so passa se estiver na lista permitida.
    fromPhone(msg) {
      if (!msg || !ALLOWED.has(msg.cmd)) return false;
      const { type, ...rest } = msg;
      return this.send(rest);
    }
  }

  return new OfficeBridge();
})();

// ==================== updater ====================
const updater = (() => {
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
  const appConfig = config;

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

  return { checkForUpdate, launchApplyIfReady, applyPendingUpdate, compareVersions };
})();

// ==================== setup ====================
const setup = (() => {
  // Assistente de configuração do Imago -- roda uma vez (ou quando quiser
  // trocar de apresentação) e salva tudo em config.json, do lado do programa.
  // Depois disso, o uso do dia a dia é só abrir o Imago normalmente.
  //
  // Como usar:
  //   - Rodando com Node instalado:  npm run configurar
  //   - Já empacotado (.exe/.app):   dê duplo clique em "Configurar" (veja README)
  //
  // Alternativa ainda mais rápida, sem passar por este assistente: arraste o
  // arquivo .pptx da apresentação direto em cima do ícone do Imago (do .exe ou
  // do atalho "Iniciar Imago") -- o app salva o caminho sozinho e já abre.

  const fs = require('fs');
  const readline = require('readline');

  function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, resolve));
  }

  async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n=== Configuração do Imago ===\n');
    console.log('Isso leva 10 segundos e só precisa ser feito uma vez por apresentação.');

    const candidates = config.findPptxCandidates();

    if (candidates.length) {
      console.log('\nArquivos .pptx encontrados no seu computador:\n');
      candidates.forEach((file, i) => console.log(`  ${i + 1}) ${file}`));
      console.log('  0) Nenhum desses / não usar notas e miniaturas por enquanto\n');

      const answer = (
        await ask(rl, 'Digite o número do arquivo (ou cole outro caminho, ou Enter para pular): ')
      ).trim();

      let pptxPath = '';
      if (answer === '' || answer === '0') {
        pptxPath = '';
      } else if (/^\d+$/.test(answer) && candidates[Number(answer) - 1]) {
        pptxPath = candidates[Number(answer) - 1];
      } else {
        pptxPath = answer.replace(/^["']|["']$/g, ''); // remove aspas se colar "caminho com espaço"
      }

      finish(pptxPath);
    } else {
      console.log('\nNenhum .pptx foi encontrado automaticamente nas pastas comuns.');
      const answer = (
        await ask(
          rl,
          'Cole o caminho completo do arquivo .pptx (ou Enter para usar sem notas/miniaturas): '
        )
      ).trim();
      finish(answer.replace(/^["']|["']$/g, ''));
    }

    function finish(pptxPath) {
      if (pptxPath && !fs.existsSync(pptxPath)) {
        console.log(`\n[Aviso] Não encontrei o arquivo em "${pptxPath}". Salvando mesmo assim --`);
        console.log('        confira o caminho depois rodando a configuração de novo, se precisar.');
      }
      config.save({ pptxPath });
      console.log(pptxPath ? `\nConfigurado! Apresentação: ${pptxPath}` : '\nConfigurado! Rodando sem notas/miniaturas.');
      console.log('Pode fechar esta janela e abrir o Imago normalmente agora.\n');
      rl.close();
    }
  }

  return { runWizard: main };
})();

module.exports = { config, history, thumbnails, office, updater, setup };
