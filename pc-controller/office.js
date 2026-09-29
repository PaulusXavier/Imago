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

module.exports = new OfficeBridge();
