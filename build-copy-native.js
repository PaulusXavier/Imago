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
  process.exit(0);
}

copyDir(nativeSrc, nativeDest);

// Atalho de duplo clique para abrir o assistente de configuração sem
// precisar saber usar terminal / linha de comando.
if (target === 'win') {
  fs.writeFileSync(
    path.join(outDir, 'Configurar.bat'),
    '@echo off\r\nImago.exe --configurar\r\npause\r\n'
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

1. Copie/zipe A PASTA INTEIRA (não só o .exe) para o computador que vai
   apresentar, ou envie o .zip por e-mail/pendrive.
2. Dê duplo clique no arquivo Imago (.exe no Windows).
3. Um QR code aparece no terminal -- só isso, sem instalar Node.js nem npm.

Para configurar a apresentação (título/notas/miniaturas dos slides):
- Mais fácil: arraste o arquivo .pptx em cima do Imago.exe.
- Ou dê duplo clique no atalho "Configurar" que está nesta mesma pasta.

Sem isso, o controle de próximo/anterior slide já funciona normalmente.
`;

fs.writeFileSync(path.join(outDir, 'LEIA-ME.txt'), leiaMe, 'utf8');

console.log(`[OK] Arquivos nativos copiados e pasta pronta em: ${outDir}`);
console.log('     Distribua essa pasta inteira (zipada) para quem for usar o Imago no PC.');
