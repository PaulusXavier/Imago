// O "pkg" (usado pra gerar o .exe/binário único, veja package.json) consegue
// empacotar todo o código JavaScript dentro do executável, mas NÃO consegue
// empacotar módulos nativos compilados (como o robotjs, que simula as
// teclas). Por isso, depois de gerar o .exe, este script copia a pasta
// inteira do robotjs pra dentro da mesma pasta do executável -- resultado:
// uma pastinha com 2 itens (o .exe + uma pasta "node_modules") que dá pra
// zipar e mandar pra qualquer pessoa. Ela só precisa extrair e dar duplo
// clique no .exe; não precisa instalar Node.js nem rodar "npm install".

const fs = require('fs');
const path = require('path');

const PLATFORM_DIRS = { win: 'win', mac: 'mac', linux: 'linux' };
const target = process.argv[2];

if (!PLATFORM_DIRS[target]) {
  console.error('Uso: node build-copy-native.js <win|mac|linux>');
  process.exit(1);
}

const outDir = path.join(__dirname, 'dist', PLATFORM_DIRS[target]);
// Copiamos a pasta node_modules/robotjs INTEIRA (não só o binário nativo):
// o controller.js agora carrega o robotjs de fora do .exe empacotado (veja
// o comentário sobre "robotModuleDir" em controller.js), então precisa dos
// arquivos .js do próprio pacote além do binário nativo.
const nativeSrc = path.join(__dirname, 'node_modules', 'robotjs');
const nativeDest = path.join(outDir, 'node_modules', 'robotjs');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(nativeSrc)) {
  console.log(`[Aviso] Não encontrei ${nativeSrc}.`);
  console.log('        Rode "npm install" nesta pasta antes de gerar o instalável (build:*).');
  process.exit(1);
}

copyDir(nativeSrc, nativeDest);

// Deixa cópias externas dos scripts de fallback. Assim o app continua
// encontrando os recursos mesmo quando o Windows bloqueia arquivos internos
// do executável empacotado ou quando a pasta foi extraída em um local especial.
for (const resource of ['input-bridge.ps1', 'office-bridge.ps1']) {
  const source = path.join(__dirname, resource);
  const destination = path.join(outDir, resource);
  if (fs.existsSync(source)) fs.copyFileSync(source, destination);
}

// Atalho de duplo clique para abrir o assistente de configuração sem
// precisar saber usar terminal / linha de comando.
if (target === 'win') {
  fs.writeFileSync(
    path.join(outDir, 'Configurar.bat'),
    '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0Imago.exe" --configurar\r\npause\r\n'
  );
} else {
  const script = '#!/bin/bash\ncd "$(dirname "$0")"\n./Imago --configurar\n';
  const dest = path.join(outDir, 'Configurar.command');
  fs.writeFileSync(dest, script);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* em alguns sistemas de arquivos (ex: rodando isso no Windows) o chmod não é suportado */
  }
}

const leiaMe = `Imago - pasta pronta para distribuir
======================================

Esta pasta inteira é o "app" do PC. Para usar:

1. Extraia o ZIP completamente. Não abra o Imago de dentro do ZIP e não
   mova o .exe para fora desta pasta.
2. Coloque a pasta em um local gravável, como Área de Trabalho ou Documentos.
   Evite Program Files, pastas somente leitura e pastas sincronizadas enquanto
   estiver configurando pela primeira vez.
3. Dê duplo clique em "Imago.exe" ou em "Iniciar Imago.bat".
4. Um QR code aparece na janela preta do Imago. Deixe essa janela aberta
   durante a apresentação. Não precisa instalar Node.js nem npm.
5. Se o Windows Defender perguntar sobre a rede, permita o Imago em redes
   privadas para o celular conseguir usar Wi-Fi.

Para configurar a apresentação (título/notas/miniaturas dos slides):
- Mais fácil: arraste o arquivo .pptx em cima do Imago.exe.
- Ou dê duplo clique em "Configurar.bat" nesta mesma pasta.
- PowerPoint/Word/Excel precisam estar instalados para a aba Office e a leitura
  do documento aberto. Sem o Office, o controle de slides ainda funciona.
- Miniaturas de um .pptx sem Office exigem LibreOffice e Poppler instalados;
  notas e títulos continuam disponíveis quando o .pptx foi configurado.

Sem configurar um .pptx, o controle de próximo/anterior ainda funciona quando
o PowerPoint ou Prezi estiver aberto e em modo apresentação.

Se nada aparecer: extraia novamente o ZIP, confirme que a pasta inteira foi
mantida junta e abra "Iniciar Imago.bat". Se o Windows mostrar SmartScreen,
use Mais informações > Executar assim mesmo somente se o ZIP veio da fonte
que você confia.
`;

fs.writeFileSync(path.join(outDir, 'LEIA-ME.txt'), leiaMe, 'utf8');

if (target === 'win') {
  fs.writeFileSync(
    path.join(outDir, 'Iniciar Imago.bat'),
    '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0Imago.exe"\r\n'
  );
}

console.log(`[OK] Arquivos nativos copiados e pasta pronta em: ${outDir}`);
console.log('     Distribua essa pasta inteira (zipada) para quem for usar o Imago no PC.');
