# Imago -- Controle Remoto de Apresentação (estilo Office Remote)

Controle o PowerPoint ou o Prezi pelo celular. Funciona em três cenários:
- **Wi-Fi** (celular e PC na mesma rede) — conexão direta, mais rápida
- **Offline** (sem internet nenhuma, incluindo hotspot do próprio PC) — mesma conexão direta acima
- **Dados móveis** (redes diferentes) — via um servidor "relay" na internet

O app tenta a conexão local primeiro e cai para o relay automaticamente se não conseguir.

## Duas etapas bem diferentes

Este projeto tem duas partes que **não se misturam**:

1. **Configuração única** — feita **uma vez só**, por quem está distribuindo o Imago (você). É aqui que entram conta no Render, GitHub Pages, editar URL, etc.
2. **Uso do dia a dia** — feito por qualquer pessoa que vá apresentar, **quantas vezes quiser**, depois que a etapa 1 já foi feita. Aqui é só "abrir o app no PC" + "abrir o app no celular", como no Office Remote — nada de instalar Node.js, editar arquivo ou digitar URL.

Se você é quem vai *usar* o Imago (não configurá-lo pela primeira vez), pule direto para [Uso do dia a dia](#uso-do-dia-a-dia-estilo-office-remote).

---

## Configuração única (feita por você, uma vez)

### 1. Publicar o relay (Render)
1. Suba a pasta `relay-server/` para um repositório no GitHub (pode ser este mesmo).
2. No [Render](https://render.com), crie um **Web Service** novo apontando para esse repositório/pasta.
   - Build command: `npm install`
   - Start command: `npm start`
3. Copie a URL gerada (algo como `https://seu-relay.onrender.com`) e troque `https://` por `wss://`.

### 2. Publicar o app do celular (GitHub Pages)
1. Suba a pasta `web-app/` para o repositório no GitHub.
2. Em Settings → Pages, aponte para a pasta `web-app/` (ou mova o conteúdo pra raiz do repo, como preferir).
3. Edite `web-app/app.js` e coloque a URL do relay (passo 1) na constante `RELAY_URL`.

A partir daqui, a URL do GitHub Pages é **fixa para sempre** (ex: `https://voce.github.io/imago`) — é ela que todo mundo vai abrir no celular, uma vez, para instalar o app. Ninguém mais vai precisar mexer nisso.

### 3. Gerar o instalável do PC (não precisa mais editar `controller.js`)
1. Instale o [Node.js](https://nodejs.org) **só nesta etapa**, na sua própria máquina (quem vai apresentar depois não precisa disso).
2. Entre na pasta `pc-controller/` e rode `npm install`.
   - Obs: `robotjs` compila um módulo nativo. Se der erro, instale as "build tools" do seu sistema (Windows: Visual Studio Build Tools; macOS: Xcode Command Line Tools; Linux: `build-essential`).
3. Configure a URL do relay e do app publicado, por variável de ambiente na hora de gerar o instalável (não precisa mais editar o arquivo):
   - Windows (PowerShell): `$env:RELAY_URL="wss://seu-relay.onrender.com"; $env:WEB_APP_URL="https://voce.github.io/imago"`
   - macOS/Linux: `export RELAY_URL=wss://seu-relay.onrender.com WEB_APP_URL=https://voce.github.io/imago`
4. Gere o executável (escolha o(s) sistema(s) que vai distribuir):
   ```
   npm run build:win     # gera dist/win/Imago.exe (Windows)
   npm run build:mac     # gera dist/mac/Imago (macOS)
   npm run build:linux   # gera dist/linux/Imago (Linux)
   ```
   Isso cria uma pasta (`dist/win/`, por exemplo) com o executável + os arquivos nativos necessários + um atalho "Configurar" + um `LEIA-ME.txt`.
5. **Zipe essa pasta inteira** (não só o `.exe`) e distribua para quem vai apresentar. É esse zip que vira "o app do PC" — quem recebe não precisa instalar Node.js, nem rodar `npm install`, nem editar nada.

> Se preferir não gerar um instalável e só rodar direto com Node.js instalado (por exemplo, pra testar), continua funcionando normalmente com `npm start` dentro de `pc-controller/`, usando as mesmas variáveis de ambiente `RELAY_URL`/`WEB_APP_URL`/`PPTX_PATH`.

### 4. Atualização automática do app do PC (opcional)

Depois que o Imago já foi distribuído, o app do PC pode se atualizar sozinho, sem que quem apresenta precise baixar um zip novo na mão. Funciona assim: toda vez que o Imago abre, ele confere um arquivo `version.json` publicado na internet; se houver uma versão mais nova, baixa o instalável correspondente em segundo plano (sem travar nem avisar nada na apresentação) e só troca os arquivos quando o Imago for fechado — nesse momento ele mesmo reabre já atualizado.

Pra ativar isso:
1. `web-app/version.json` (já incluído neste repositório) é o manifesto — por padrão o Imago procura ele do lado da PWA publicada (mesmo GitHub Pages do passo 2), então normalmente não precisa configurar nada além de mantê-lo atualizado. Se preferir hospedar em outro lugar, aponte pra ele com a variável de ambiente `UPDATE_MANIFEST_URL` na hora de gerar o instalável (passo 3).
2. Sempre que quiser publicar uma versão nova:
   - Suba o número de `"version"` em `pc-controller/package.json` (ex: `1.1.0` → `1.2.0`).
   - Rode `npm run build:win` / `build:mac` / `build:linux` normalmente e zipe cada pasta `dist/<sistema>/` (o mesmo zip de sempre, que já contém o `.exe`/executável + arquivos nativos).
   - Suba esses zips pra algum lugar com link direto de download por **HTTPS** — o jeito mais simples é uma [Release do GitHub](https://docs.github.com/repositories/releasing-projects-on-github/managing-releases-in-a-repository) no mesmo repositório (arrasta os zips ao criar a release; o link de cada arquivo fica em algo como `https://github.com/voce/imago/releases/download/v1.2.0/imago-win.zip`).
   - Calcule o **SHA-256** de cada zip (o Imago recusa qualquer atualização cujo checksum não bater, então esse passo não é opcional):
     - Windows (PowerShell): `Get-FileHash imago-win.zip -Algorithm SHA256`
     - macOS: `shasum -a 256 imago-mac.zip`
     - Linux: `sha256sum imago-linux.zip`
   - Edite `web-app/version.json`, atualize `"version"` para o novo número e preencha `"downloads"` com a URL (https) + o hash de cada sistema, por exemplo:
     ```json
     "win": { "url": "https://github.com/voce/imago/releases/download/v1.2.0/imago-win.zip", "sha256": "9f2c...64 caracteres..." }
     ```
     Pode deixar `{ "url": "", "sha256": "" }` os sistemas que não for atualizar dessa vez — o Imago simplesmente não vai encontrar atualização válida pra eles. Publique essa mudança (commit + push, já que `web-app/` é servido pelo GitHub Pages).
3. Pronto — todo Imago já instalado em qualquer PC vai detectar a versão nova na próxima vez que for aberto, conferir o checksum, baixar sozinho e aplicar ao fechar.

**Proteções embutidas** (pra quem for confiar nisso): a URL de manifesto e de download só é aceita em `https://` (inclusive em redirecionamentos); o `.zip` baixado é descartado se o SHA-256 não bater com o do manifesto; o manifesto é ignorado se vier com formato/tipos inesperados; há limite de tamanho tanto pro manifesto quanto pro download; e o conteúdo do `.zip` é conferido contra tentativas de gravar fora da pasta de destino ("zip slip") antes de ser extraído.

> A checagem só existe no app já empacotado (`.exe`/binário gerado com `npm run build:*`); rodando com `npm start`/`node controller.js` direto (modo desenvolvimento) ela é pulada, porque não há um executável pra trocar.

---

## Uso do dia a dia (estilo Office Remote)

Depois que a configuração única acima foi feita por alguém, usar o Imago fica assim:

### No celular (uma vez, "instalar o app")
1. Abra a URL publicada (GitHub Pages) no navegador do celular.
2. Toque em **"📲 Instalar app na tela inicial"** (ou, se o navegador não mostrar esse botão, no menu ⋮/compartilhar → "Adicionar à tela inicial").
3. Pronto — agora existe um ícone do Imago na tela inicial, como qualquer outro app.

### No PC (toda vez que for apresentar)
1. Extraia o zip do Imago (se ainda não tiver feito) em qualquer pasta.
2. Dê duplo clique no **Imago** (`Imago.exe` no Windows). Um QR code aparece na tela.
3. *(Opcional, só na primeira vez com aquela apresentação)* Para ativar notas do apresentador e miniaturas dos slides: arraste o arquivo `.pptx` para cima do ícone do Imago, ou dê duplo clique no atalho **Configurar** e escolha o arquivo na lista. Sem isso, a navegação de slides já funciona normalmente.

### Conectando os dois
1. Abra o PowerPoint/Prezi em modo de apresentação.
2. Abra o ícone do Imago no celular (o que você instalou na tela inicial) e escaneie o QR code que apareceu no PC.
3. Use os botões de próximo/anterior, ou arraste o dedo pros lados.

Da próxima vez, o celular lembra a última conexão sozinho — não precisa escanear QR code de novo, a não ser que troque de PC/rede **ou que o Imago tenha sido fechado e reaberto** (o código de segurança muda a cada abertura, por segurança — veja [Segurança da conexão](#segurança-da-conexão)).

## Segurança da conexão

- **Código de segurança por sessão**: toda vez que o Imago abre, ele gera um código aleatório novo (mostrado na tela junto do QR code, e embutido no link/QR automaticamente). Sem esse código, ninguém consegue mandar comandos — nem quem estiver na mesma rede Wi-Fi conectando direto na porta do Imago, nem quem tentar adivinhar o código de 6 dígitos do relay. Se o Imago for fechado e reaberto, o código muda; é só escanear o QR de novo (ou digitar o novo código na tela de conexão manual do celular).
- **Relay**: o código de pareamento tem 6 dígitos (antes eram 4) e há limite de tentativas por conexão e de novas conexões por IP, além de não permitir que um segundo celular "roube" silenciosamente uma sessão já conectada.
- **Atualização automática**: só aceita HTTPS e só aplica um pacote cujo SHA-256 bata com o publicado no manifesto (veja [Atualização automática do app do PC](#4-atualização-automática-do-app-do-pc-opcional)).

## Funcionalidades

- Navegação de slides por botão ou arrastando o dedo para os lados
- **Título e notas do apresentador sincronizados automaticamente**, lidos direto do arquivo `.pptx` (configure arrastando o arquivo sobre o Imago, ou pelo atalho "Configurar")
- **Miniaturas reais dos slides**: aba "Miniaturas" mostra a imagem de cada slide (não só o título) e permite tocar numa miniatura pra pular direto pra aquele slide. Requer LibreOffice + Poppler instalados no PC — veja [Miniaturas dos slides](#miniaturas-dos-slides-opcional) abaixo. Sem essas ferramentas, essa aba mostra um aviso e o resto do app continua funcionando normalmente.
- **Histórico de sessões**: aba "Histórico" lista as últimas apresentações feitas (data/hora, duração, até qual slide você chegou). Fica salvo localmente no PC, do lado do executável, em `session-history.json`.
- **Apontador laser**: aba "Laser" com um touchpad — arraste o dedo pra mover o cursor/laser na tela (ativa o Ctrl+L do PowerPoint automaticamente)
- Tela do celular não apaga sozinha durante a apresentação (Wake Lock)
- Reconexão automática se a rede oscilar, ou se o celular voltar de segundo plano (tela bloqueada) no meio da apresentação
- Lembra a última conexão usada, então não precisa escanear o QR toda vez
- Vibração ao tocar nos botões
- App instalável na tela inicial do celular (Progressive Web App) e executável único no PC (sem precisar de Node.js instalado por quem vai apresentar)
- **Atualização automática do app do PC**: o Imago confere sozinho se há uma versão nova ao abrir, baixa em segundo plano e aplica ao fechar — quem apresenta nunca precisa baixar um zip novo na mão (veja [Atualização automática do app do PC](#4-atualização-automática-do-app-do-pc-opcional))

## Miniaturas dos slides (opcional)

Pra ver a imagem de cada slide (e não só o título), o PC precisa converter o `.pptx` em imagens quando o Imago inicia. Isso usa duas ferramentas gratuitas que **não vêm junto com o Imago** e precisam ser instaladas separadamente, uma vez, no computador que vai apresentar:

1. **LibreOffice** (usa o comando `soffice`) — [libreoffice.org](https://www.libreoffice.org/download/)
2. **Poppler** (usa o comando `pdftoppm`) — no Windows, baixe um build pronto (ex: [poppler para Windows](https://github.com/oschwartz10612/poppler-windows/releases)) e adicione a pasta `bin` ao PATH; no macOS, `brew install poppler`; no Linux, `sudo apt install poppler-utils` (ou equivalente da sua distro).

Depois de instalados, basta configurar a apresentação normalmente (arrastando o `.pptx` ou pelo atalho "Configurar") — as miniaturas são geradas automaticamente em segundo plano na primeira vez que o Imago roda com aquele arquivo (ficam em cache, então da próxima vez que abrir a mesma apresentação é instantâneo). Se preferir apontar os caminhos manualmente em vez de depender do PATH, use as variáveis de ambiente `SOFFICE_PATH` e `PDFTOPPM_PATH`.

Se qualquer uma das duas ferramentas não for encontrada, o app simplesmente avisa isso no terminal e na aba "Miniaturas" do celular — a navegação, as notas e o restante seguem funcionando normalmente.

## Limitações
- O apontador laser usa o atalho Ctrl+L, específico do PowerPoint em modo de apresentação. No Prezi, mover o cursor funciona, mas não há um modo "laser" dedicado — o cursor normal já indica onde você está apontando.
- `robotjs` simula teclas físicas (setas), então funciona com PowerPoint Desktop e Prezi Desktop, mas não com apresentações abertas só no navegador (falta de foco de janela pode exigir clicar na apresentação uma vez antes de começar).
- O "ir direto pro slide" (miniaturas) usa o atalho de digitar o número do slide + Enter, específico do modo apresentação do PowerPoint/Prezi.
- O histórico de sessões só é salvo quando você usa os botões "Iniciar"/"Encerrar" do app — se você fechar o Imago no meio de uma apresentação sem usar "Encerrar" (ou fechar a janela do terminal, que ele trata como Ctrl+C), aquela sessão não é registrada.
- O contador de slide é calculado pelos próprios comandos de próximo/anterior enviados pelo app (não lê o PowerPoint diretamente), então navegar pela apresentação usando o teclado/mouse do PC diretamente (fora do celular) vai dessincronizar o contador — isso também afeta as miniaturas e o histórico.
- O PC precisa continuar ligado e com o Imago aberto durante toda a apresentação.
- Gerar o `.exe`/binário (`npm run build:*`) precisa ser feito em cada sistema operacional que você quer suportar (não dá pra gerar o `.exe` do Windows a partir de um Mac, por exemplo, por causa do módulo nativo `robotjs`).
- Se uma atualização for baixada em segundo plano, ela só é aplicada quando o Imago for **fechado** (nunca no meio de uma apresentação) — nesse momento o app reabre sozinho, então não estranhe se a janela "piscar" ao fechar depois de uma apresentação.
