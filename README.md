# Imago — controle remoto de apresentações (Bluetooth + Wi-Fi em um app só)

Um único app Android com **dois modos**:

|  | **Bluetooth** (padrão) | **Wi-Fi / internet** (opcional) |
| --- | --- | --- |
| Precisa instalar algo no PC? | **Não** | Sim (`Imago.exe`) |
| Próximo/anterior, iniciar, encerrar, tela preta/branca, primeiro/último, ir para o slide N | ✅ | ✅ |
| Apontador laser (touchpad) + toque para clicar | ✅ | ✅ |
| Iniciar da apresentação atual (Shift+F5) | ✅ | ✅ |
| Botões de volume trocam slide | ✅ | ✅ |
| Notas, miniaturas, histórico, aba Office | — | ✅ |

No dia a dia: **abra o app → Conectar por Bluetooth → apresente.** Se você precisar de notas/miniaturas, use o modo Wi-Fi com o `Imago.exe` (veja a seção **Modo Wi-Fi / internet (PC)** abaixo).

## Instalar e usar (caminho mais fácil)

### Android + Bluetooth — recomendado

1. No celular, abra o site publicado do Imago e toque em **Baixar app Android (APK)**.

1. Abra o arquivo baixado. Se o Android perguntar, permita **instalar apps desta fonte** apenas para o navegador usado.

1. Abra o Imago e toque em **Conectar por Bluetooth**.

1. Na primeira vez, o próprio Imago abre as configurações Bluetooth: toque no nome do PC para parear e volte ao Imago. Ele tenta conectar sozinho.

1. Abra o PowerPoint/Prezi no modo apresentação. Pronto: **Próximo**, **Anterior**, deslizar o dedo e botões de volume funcionam sem instalar nada no PC.

### Se você não quiser instalar APK

Abra o site no celular e escolha **Instalar a versão web**. No Chrome/Android, essa versão pode usar o Bluetooth web experimental; no iPhone/iPad, use Safari › Compartilhar › **Adicionar à Tela de Início** e conecte por Wi-Fi/internet.

### Computador

Para Bluetooth, **não instale nada no PC**. Para notas, miniaturas, laser e Office, baixe o **Imago para Windows** exibido na tela de conexão e abra o `Imago.exe`.

### Bluetooth pelo app web/PWA

Também é possível usar o Bluetooth sem o APK Android: instale o Imago no **Chrome para Android** pelo botão **Instalar o Imago** e, com o `Imago.exe` aberto no PC, toque em **Conectar Bluetooth web**.

Requisitos: página publicada em **HTTPS**, Chrome/Android com Web Bluetooth e um adaptador do PC que suporte o papel BLE periférico. Na primeira vez, escolha **Imago Web** na janela do navegador e permita o acesso. O APK nativo continua disponível como alternativa para aparelhos que não suportam Web Bluetooth.

## Escolher Wi‑Fi ou dados móveis

Na tela **Wi-Fi / internet**, o botão **Usar conexão** oferece três modos:

- **Automático:** tenta a conexão direta pelo Wi‑Fi primeiro; se o celular estiver fora da rede, usa o relay pela internet.

- **Wi‑Fi:** força a conexão local. É a opção mais rápida e funciona mesmo sem internet, desde que o celular e o PC estejam na mesma rede.

- **Dados móveis:** força o relay pela internet. Use quando o celular estiver no 4G/5G ou em outra rede.

O Imago lembra a última opção escolhida. Para dados móveis, o PC precisa estar conectado ao relay configurado e o celular deve usar o código de 6 dígitos exibido junto do QR code.

## Publicar (uma vez, ~5 minutos)

1. Suba esta pasta inteira para o repositório `paulusxavier/Imago` (branch `main`). **Confira que a pasta oculta ****`.github/workflows/apk.yml`**** foi junto** — sem ela o GitHub não gera o APK (o arrastar-e-soltar do navegador costuma ignorar pastas ocultas; se acontecer, use *Add file › Create new file* e digite o caminho `.github/workflows/apk.yml`).

1. No GitHub, aba **Actions** → aguarde o job **Gerar APK do Imago** ficar verde (~5–8 min).

1. No celular, abra: `https://github.com/paulusxavier/Imago/releases/download/apk-latest/Imago.apk`, baixe e instale (permita "instalar apps desta fonte" ).

1. Em **Settings › Pages**, aponte para `main` + pasta `/ (root)` (mantém a versão web/PWA funcionando).

A cada novo commit o APK é regerado no mesmo link.

## Usar por Bluetooth depois da instalação

1. Ligue o Bluetooth do celular e do PC.

1. Abra o Imago: ele tenta reconectar ao último PC automaticamente.

1. Se a conexão cair, toque no aviso **Bluetooth caiu — reconectando…** para tentar imediatamente.

1. Se trocar de computador, toque em **Atualizar computadores pareados**, escolha o PC e conecte.

Teclas enviadas: → ← (slides), Home/End, F5, Esc, B, W, Ctrl+L (laser) e número+Enter (ir para slide).

## Novidades da versão 2.7

- **Wi-Fi funciona pelo navegador:** o `Imago.exe` agora serve a tela do celular pela própria rede local (`http://IP-do-PC:8765`). O QR code aponta para ele, então abre na hora, funciona **sem internet** e sem o bloqueio de "conteúdo misto" que impedia uma página HTTPS (GitHub Pages) de abrir `ws://` no Chrome/Safari (iPhone incluído). O link do site publicado continua impresso, para uso por dados móveis.
- **Abrir pelo QR já conecta** (sem tocar em Conectar) e o código de segurança some da barra de endereços.
- **Notas e títulos corretos:** o `.pptx` é lido na ordem real dos slides (antes, slides reordenados no PowerPoint apareciam trocados), o título vem do marcador de título e a primeira linha das notas não se perde mais.
- **Bluetooth:** a reconexão automática ao abrir o app agora entra sozinha no controle; arrastes lentos do laser não são mais "engolidos".
- **Estabilidade do PC:** uma mensagem malformada ou gigante vinda da rede não derruba mais o Imago (era possível sem autenticar); vários celulares recebem os slides ao mesmo tempo.
- **IP certo no QR:** adaptadores virtuais (Hyper-V/WSL, VirtualBox, VPN) deixam de ser escolhidos; os demais endereços aparecem no terminal.
- **Atualização automática do PC:** o processo que troca os arquivos agora roda de uma cópia temporária (o `.exe` em uso não podia ser sobrescrito no Windows).
- **GitHub Actions:** o `pc.yml` tinha `secrets` dentro de `if:` (o GitHub rejeita o workflow inteiro); corrigido. Os dois workflows rodam `npm test`, e o `apk.yml` solto na raiz foi removido (a versão certa fica em `.github/workflows/`).
- Assistente de configuração encontra `.pptx` em pastas dentro do OneDrive; `versionName` do APK vem do `package.json`; backup automático do Android desligado (o app guarda o código de segurança).

### Correções da revisão de código (sobre a 2.7)

- **Web Bluetooth:** títulos e notas com acento (ã, é, ç…) chegavam corrompidos (`��`) quando o texto era dividido em pacotes de 20 bytes; agora o texto é remontado corretamente. Se a autenticação falha, a conexão Bluetooth também é encerrada (antes ficava aberta no PC).
- **App abre mesmo com o armazenamento do navegador bloqueado** (modo privado / cookies bloqueados): antes uma exceção no `localStorage` derrubava a tela inteira.
- **Reconexão:** tocar em *Desconectar* durante uma tentativa de reconexão não deixa mais uma conexão "fantasma" ativa no PC. O aviso de reconexão volta ao texto normal depois de usar o Bluetooth.
- **Laser:** desconectar com a aba *Laser* aberta desliga o laser (antes ficava preso no PowerPoint).
- **Touchpad:** os movimentos são somados e enviados ~60 vezes por segundo também por Wi-Fi, internet e Web Bluetooth (o cursor deixa de atrasar pelo relay).
- **Cronômetro pausado** não é mais sobrescrito pelo tempo do PowerPoint; atalhos com Ctrl/Alt (ex.: Alt+← do navegador) não trocam mais de slide; a prévia do próximo slide também aparece fora do modo Office.
- **PC:** o histórico da apresentação em andamento é salvo em qualquer forma de encerramento (SIGTERM/SIGHUP/fechar a janela; antes só no Ctrl+C); *Iniciar deste slide* não zera mais o contador; o código de segurança é sorteado de forma uniforme.
- **Miniaturas (macOS/Linux):** o LibreOffice roda com perfil próprio (não conflita com um LibreOffice já aberto), tem limite de tempo (3 min) e o aviso final não é mais duplicado.
- **Atualização automática:** um download cortado no meio agora falha com mensagem em vez de travar; o `chmod` só mexe no executável `Imago`.
- **Relay:** o celular não consegue mais se passar pelo próprio relay (mensagens como `phone-disconnected`/`session-created` enviadas por ele são descartadas).
- **Android:** campos compartilhados entre threads do `ImagoHidPlugin` agora são `volatile`.
- **Testes:** `logic_test.js` passou a testar o código real do atualizador (antes testava cópias); novos testes de integração do relay e do controller. Comentários desatualizados (`updater.js`, `office.js`, "4 dígitos") corrigidos.

## Novidades da versão 2.x

- **Toque no touchpad = clique do mouse** (Prezi, vídeos, links).

- **Iniciar deste slide** (Shift+F5), além de Iniciar (F5).

- **Cronômetro:** toque pausa/continua, duplo toque zera.

- **Ícone próprio** do Imago no celular.

- **Atualiza por cima:** o APK agora usa uma chave fixa (`android/app/imago.keystore`), então instalar um APK novo atualiza o app sem desinstalar. Se você já instalou o APK anterior, desinstale-o uma única vez.

- Ao tocar em *Desconectar*, o app não volta sozinho para o controle quando o Windows reconecta.

## Se algo não funcionar

| Sintoma | O que fazer |
| --- | --- |
| A aba **Actions** está vazia / o APK não aparece | O arquivo `.github/workflows/apk.yml` não foi enviado (veja o passo 1 de *Instalar*). |
| Diz "Bluetooth desligado" | Ligue o Bluetooth do celular e toque em **Conectar** de novo. |
| "Nenhum computador pareado" | Pareie o celular com o PC no Windows (*Configurações › Bluetooth*); se aparecer uma lista no app, escolha o seu PC. |
| Conecta, mas o slide não muda | Clique uma vez na janela do PowerPoint/Prezi (ela precisa estar em foco) e use o modo apresentação. |
| Não conecta pela internet | Confira `RELAY_URL` no `app.js`. No plano gratuito do Render o relay leva até ~1 min para acordar. |
| O terminal repete mensagens do relay | Se você só usa Wi-Fi, deixe o relay sem configurar: o Imago não tenta conectar. Se o relay estiver configurado e cair, as tentativas agora usam intervalos progressivos e não interrompem o Wi-Fi local. |

## Limitações

- Bluetooth HID exige Android 9+ e depende do fabricante (alguns aparelhos não permitem apps atuarem como teclado).

- Sem leitura do slide atual/notas/miniaturas no modo Bluetooth (o PC não tem programa para responder).

- Na web/PWA, Bluetooth está disponível experimentalmente no Chrome/Android quando o PC anuncia BLE; nos demais navegadores, use Wi-Fi/internet.

- O APK é "debug" com chave fixa incluída no repositório: ótimo para uso pessoal, não serve para a Play Store.

- Se o repositório for público, qualquer pessoa pode assinar um APK com essa chave; para uso pessoal isso não é problema.

## Estrutura

Tudo na raiz, exceto o projeto Android e o workflow:

- `index.html`, `app.js`, `sw.js`, `manifest.json`, `version.json`, `icon.svg`, `capacitor.js` — interface do celular (usada no APK e no GitHub Pages)

- `controller.js`, `modules.js`, `office-bridge.ps1`, `build-copy-native.js` — programa do PC (modo Wi-Fi/internet): `modules.js` reúne config, histórico, miniaturas, ponte Office, atualizador e assistente

- `relay-server.js` — servidor relay (modo internet)

- `logic_test.js`, `modules_test.js`, `relay_test.js` e `controller_test.js` — testes (`npm test`): segurança/atualização (código real do `modules.js`), leitura do `.pptx`, escolha do IP, o relay de verdade e o programa do PC de verdade (com um `robotjs` de mentira)

- `package.json` — um só para tudo (app Android, PC e relay)

- `capacitor.config.json` e `android/` — projeto Android (Capacitor) com `ImagoHidPlugin.java` (teclado + mouse Bluetooth)

- `.github/workflows/apk.yml` e `pc.yml` — geram o APK e o `Imago.exe` no GitHub

# Modo Wi-Fi / internet (PC)

Controle o PowerPoint ou o Prezi pelo celular. Funciona em três cenários:

- **Wi-Fi** (celular e PC na mesma rede) — conexão direta, mais rápida

- **Offline** (sem internet nenhuma, incluindo hotspot do próprio PC) — mesma conexão direta acima

- **Dados móveis** (redes diferentes) — via um servidor "relay" na internet

O app tenta a conexão local primeiro e cai para o relay automaticamente se não conseguir.

### Duas etapas bem diferentes

Este projeto tem duas partes que **não se misturam**:

1. **Configuração única** — feita **uma vez só**, por quem está distribuindo o Imago (você). É aqui que entram conta no Render, GitHub Pages, editar URL, etc.

1. **Uso do dia a dia** — feito por qualquer pessoa que vá apresentar, **quantas vezes quiser**, depois que a etapa 1 já foi feita. Aqui é só "abrir o app no PC" + "abrir o app no celular", como no Office Remote — nada de instalar Node.js, editar arquivo ou digitar URL.

Se você é quem vai *usar* o Imago (não configurá-lo pela primeira vez), pule direto para [Uso do dia a dia](#uso-do-dia-a-dia-estilo-office-remote).

---

### Configuração única (feita por você, uma vez)

#### 1. Publicar o relay (Render)

1. Use este mesmo repositório (o relay é o arquivo `relay-server.js`).

1. No [Render](https://render.com), crie um **Web Service** novo apontando para esse repositório/pasta.
  - Build command: `npm install --ignore-scripts`
  - Start command: `npm run relay`

1. Copie a URL gerada (algo como `https://seu-relay.onrender.com` ) e troque `https://` por `wss://`.

#### 2. Publicar o app do celular (GitHub Pages )

1. Em Settings → Pages, aponte para a branch `main`, pasta `/ (root)` (o app do celular fica na raiz).

1. Edite `app.js` e coloque a URL do relay (passo 1) na constante `RELAY_URL`.

A partir daqui, a URL do GitHub Pages é **fixa para sempre** (ex: `https://voce.github.io/imago` ) — é ela que todo mundo vai abrir no celular, uma vez, para instalar o app. Ninguém mais vai precisar mexer nisso.

#### 3. Gerar o instalável do PC (não precisa mais editar `controller.js`)

1. Instale o [Node.js](https://nodejs.org) (20 LTS) **só nesta etapa**, na sua própria máquina (quem vai apresentar depois não precisa disso).

1. Na raiz do projeto, rode `npm install`.
  - Obs: `robotjs` compila um módulo nativo. Se der erro, instale as "build tools" do seu sistema (Windows: Visual Studio Build Tools com "Desenvolvimento para Desktop com C++"; use Node.js 20 LTS; macOS: Xcode Command Line Tools; Linux: `build-essential`).

1. Configure a URL do relay e do app publicado, por variável de ambiente na hora de gerar o instalável (não precisa mais editar o arquivo):
  - Windows (PowerShell): `$env:RELAY_URL="wss://seu-relay.onrender.com"; $env:WEB_APP_URL="https://voce.github.io/imago"`
  - macOS/Linux: `export RELAY_URL=wss://seu-relay.onrender.com WEB_APP_URL=https://voce.github.io/imago`

1. Gere o executável (escolha o(s ) sistema(s) que vai distribuir):

   ```
   npm run build:win     # gera dist/win/Imago.exe (Windows)
   npm run build:mac     # gera dist/mac/Imago (macOS)
   npm run build:linux   # gera dist/linux/Imago (Linux)
   ```

   Isso cria uma pasta (`dist/win/`, por exemplo) com o executável + os arquivos nativos necessários + um atalho "Configurar" + um `LEIA-ME.txt`.

1. **Zipe essa pasta inteira** (não só o `.exe`) e distribua para quem vai apresentar. É esse zip que vira "o app do PC" — quem recebe não precisa instalar Node.js, nem rodar `npm install`, nem editar nada.

> Se preferir não gerar um instalável e só rodar direto com Node.js instalado (por exemplo, pra testar), continua funcionando normalmente com `npm start` na raiz do projeto, usando as mesmas variáveis de ambiente `RELAY_URL`/`WEB_APP_URL`/`PPTX_PATH`.

#### 4. Atualização automática do app do PC (opcional)

Depois que o Imago já foi distribuído, o app do PC pode se atualizar sozinho, sem que quem apresenta precise baixar um zip novo na mão. Funciona assim: toda vez que o Imago abre, ele confere um arquivo `version.json` publicado na internet; se houver uma versão mais nova, baixa o instalável correspondente em segundo plano (sem travar nem avisar nada na apresentação) e só troca os arquivos quando o Imago for fechado — nesse momento ele mesmo reabre já atualizado.

Pra ativar isso:

1. `version.json` (já incluído neste repositório) é o manifesto — por padrão o Imago procura ele do lado da PWA publicada (mesmo GitHub Pages do passo 2), então normalmente não precisa configurar nada além de mantê-lo atualizado. Se preferir hospedar em outro lugar, aponte pra ele com a variável de ambiente `UPDATE_MANIFEST_URL` na hora de gerar o instalável (passo 3).

1. Sempre que quiser publicar uma versão nova:
  - Suba o número de `"version"` em `package.json` (ex: `1.1.0` → `1.2.0`).
  - Rode `npm run build:win` / `build:mac` / `build:linux` normalmente e zipe cada pasta `dist/<sistema>/` (o mesmo zip de sempre, que já contém o `.exe`/executável + arquivos nativos).
  - Suba esses zips pra algum lugar com link direto de download por **HTTPS** — o jeito mais simples é uma [Release do GitHub](https://docs.github.com/repositories/releasing-projects-on-github/managing-releases-in-a-repository) no mesmo repositório (arrasta os zips ao criar a release; o link de cada arquivo fica em algo como `https://github.com/voce/imago/releases/download/v1.2.0/imago-win.zip` ).
    - Calcule o **SHA-256** de cada zip (o Imago recusa qualquer atualização cujo checksum não bater, então esse passo não é opcional):
      - Windows (PowerShell): `Get-FileHash imago-win.zip -Algorithm SHA256`
      - macOS: `shasum -a 256 imago-mac.zip`
      - Linux: `sha256sum imago-linux.zip`
    - Edite `version.json`, atualize `"version"` para o novo número e preencha `"downloads"` com a URL (https ) + o hash de cada sistema, por exemplo:
    
       ```json
       "win": { "url": "https://github.com/voce/imago/releases/download/v1.2.0/imago-win.zip", "sha256": "9f2c...64 caracteres..." }
       ```
    
       Pode deixar `{ "url": "", "sha256": "" }` os sistemas que não for atualizar dessa vez — o Imago simplesmente não vai encontrar atualização válida pra eles. Publique essa mudança (commit + push, já que a raiz do repositório é servida pelo GitHub Pages ).

1. Pronto — todo Imago já instalado em qualquer PC vai detectar a versão nova na próxima vez que for aberto, conferir o checksum, baixar sozinho e aplicar ao fechar.

**Proteções embutidas** (pra quem for confiar nisso): a URL de manifesto e de download só é aceita em `https://` (inclusive em redirecionamentos ); o `.zip` baixado é descartado se o SHA-256 não bater com o do manifesto; o manifesto é ignorado se vier com formato/tipos inesperados; há limite de tamanho tanto pro manifesto quanto pro download; e o conteúdo do `.zip` é conferido contra tentativas de gravar fora da pasta de destino ("zip slip") antes de ser extraído.

> A checagem só existe no app já empacotado (`.exe`/binário gerado com `npm run build:*`); rodando com `npm start`/`node controller.js` direto (modo desenvolvimento) ela é pulada, porque não há um executável pra trocar.

---

### Uso do dia a dia (estilo Office Remote)

Depois que a configuração única acima foi feita por alguém, usar o Imago fica assim:

#### No celular (uma vez, "instalar o app")

1. Abra a URL publicada (GitHub Pages) no navegador do celular.

1. Toque em **"📲 Instalar app na tela inicial"** (ou, se o navegador não mostrar esse botão, no menu ⋮/compartilhar → "Adicionar à tela inicial").

1. Pronto — agora existe um ícone do Imago na tela inicial, como qualquer outro app.

#### No PC (toda vez que for apresentar)

1. Depois de baixar o ZIP, clique nele com o botão direito → **Propriedades** → marque **Desbloquear** (se aparecer) → **Aplicar**. Isso evita que o Windows carregue o bloqueio de arquivo baixado para todos os arquivos extraídos.

1. Extraia o ZIP inteiro do Imago — não abra o executável de dentro do ZIP — de preferência em Área de Trabalho ou Documentos.

1. Dê duplo clique no **Imago** (`Imago.exe` no Windows) ou em **Iniciar Imago.bat**. Uma janela preta com o QR code aparece; deixe-a aberta.

1. *(Opcional, só na primeira vez com aquela apresentação)* Para ativar notas do apresentador e miniaturas dos slides: arraste o arquivo `.pptx` para cima do ícone do Imago, ou dê duplo clique em **Configurar.bat** e escolha o arquivo na lista. Sem isso, a navegação de slides já funciona normalmente.

> O executável distribuído ainda não possui assinatura digital de um fornecedor reconhecido. Se o **Controle inteligente de aplicativos** bloquear o Imago mesmo depois de desbloquear o ZIP, não há um botão seguro de “Executar assim mesmo” nessa tela: a solução definitiva é publicar o `.exe` com certificado de assinatura de código confiável. Para um build pessoal, use apenas um arquivo que você baixou da fonte que confia e consulte **Segurança do Windows → Controle de aplicativos e navegador → Controle inteligente de aplicativos**; evite desativar essa proteção em um computador que você não administra.

O pacote também inclui `Imago.exe.sha256`. Para conferir o arquivo no PowerShell, rode `Get-FileHash .\Imago.exe -Algorithm SHA256` e compare o valor com esse arquivo. No workflow de publicação, a assinatura Authenticode é aplicada automaticamente quando os secrets `WINDOWS_CERTIFICATE_BASE64` e `WINDOWS_CERTIFICATE_PASSWORD` estão configurados; sem esses secrets, o executável continua sem assinatura digital.

#### Conectando os dois

1. Abra o PowerPoint/Prezi em modo de apresentação.

1. Abra o ícone do Imago no celular (o que você instalou na tela inicial) e escaneie o QR code que apareceu no PC.

1. Use os botões de próximo/anterior, ou arraste o dedo pros lados.

Da próxima vez, o celular lembra a última conexão sozinho — não precisa escanear QR code de novo, a não ser que troque de PC/rede **ou que o Imago tenha sido fechado e reaberto** (o código de segurança muda a cada abertura, por segurança — veja [Segurança da conexão](#seguran%C3%A7a-da-conex%C3%A3o)).

### Segurança da conexão

- **Código de segurança por sessão**: toda vez que o Imago abre, ele gera um código aleatório novo (mostrado na tela junto do QR code, e embutido no link/QR automaticamente). Sem esse código, ninguém consegue mandar comandos — nem quem estiver na mesma rede Wi-Fi conectando direto na porta do Imago, nem quem tentar adivinhar o código de 6 dígitos do relay. Se o Imago for fechado e reaberto, o código muda; é só escanear o QR de novo (ou digitar o novo código na tela de conexão manual do celular).

- **Relay**: o código de pareamento tem 6 dígitos (antes eram 4) e há limite de tentativas por conexão e de novas conexões por IP, além de não permitir que um segundo celular "roube" silenciosamente uma sessão já conectada.

- **Atualização automática**: só aceita HTTPS e só aplica um pacote cujo SHA-256 bata com o publicado no manifesto (veja [Atualização automática do app do PC](#4-atualiza%C3%A7%C3%A3o-autom%C3%A1tica-do-app-do-pc-opcional)).

### Funcionalidades

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

- **Atualização automática do app do PC**: o Imago confere sozinho se há uma versão nova ao abrir, baixa em segundo plano e aplica ao fechar — quem apresenta nunca precisa baixar um zip novo na mão (veja [Atualização automática do app do PC](#4-atualiza%C3%A7%C3%A3o-autom%C3%A1tica-do-app-do-pc-opcional))

### Miniaturas dos slides (opcional)

Pra ver a imagem de cada slide (e não só o título), o PC precisa converter o `.pptx` em imagens quando o Imago inicia. Isso usa duas ferramentas gratuitas que **não vêm junto com o Imago** e precisam ser instaladas separadamente, uma vez, no computador que vai apresentar:

1. **LibreOffice** (usa o comando `soffice`) — [libreoffice.org](https://www.libreoffice.org/download/)

1. **Poppler** (usa o comando `pdftoppm`) — no Windows, baixe um build pronto (ex: [poppler para Windows](https://github.com/oschwartz10612/poppler-windows/releases)) e adicione a pasta `bin` ao PATH; no macOS, `brew install poppler`; no Linux, `sudo apt install poppler-utils` (ou equivalente da sua distro).

Depois de instalados, basta configurar a apresentação normalmente (arrastando o `.pptx` ou pelo atalho "Configurar") — as miniaturas são geradas automaticamente em segundo plano na primeira vez que o Imago roda com aquele arquivo (ficam em cache, então da próxima vez que abrir a mesma apresentação é instantâneo). Se preferir apontar os caminhos manualmente em vez de depender do PATH, use as variáveis de ambiente `SOFFICE_PATH` e `PDFTOPPM_PATH`.

Se qualquer uma das duas ferramentas não for encontrada, o app simplesmente avisa isso no terminal e na aba "Miniaturas" do celular — a navegação, as notas e o restante seguem funcionando normalmente.

### Limitações

- O apontador laser usa o atalho Ctrl+L, específico do PowerPoint em modo de apresentação. No Prezi, mover o cursor funciona, mas não há um modo "laser" dedicado — o cursor normal já indica onde você está apontando.

- `robotjs` simula teclas físicas (setas), então funciona com PowerPoint Desktop e Prezi Desktop, mas não com apresentações abertas só no navegador (falta de foco de janela pode exigir clicar na apresentação uma vez antes de começar).

- O "ir direto pro slide" (miniaturas) usa o atalho de digitar o número do slide + Enter, específico do modo apresentação do PowerPoint/Prezi.

- O histórico de sessões só é salvo quando você usa os botões "Iniciar"/"Encerrar" do app — se você fechar o Imago no meio de uma apresentação sem usar "Encerrar" (ou fechar a janela do terminal, que ele trata como Ctrl+C), aquela sessão não é registrada.

- O contador de slide é calculado pelos próprios comandos de próximo/anterior enviados pelo app (não lê o PowerPoint diretamente), então navegar pela apresentação usando o teclado/mouse do PC diretamente (fora do celular) vai dessincronizar o contador — isso também afeta as miniaturas e o histórico.

- O PC precisa continuar ligado e com o Imago aberto durante toda a apresentação.

- Gerar o `.exe`/binário (`npm run build:*`) precisa ser feito em cada sistema operacional que você quer suportar (não dá pra gerar o `.exe` do Windows a partir de um Mac, por exemplo, por causa do módulo nativo `robotjs`).

- Se uma atualização for baixada em segundo plano, ela só é aplicada quando o Imago for **fechado** (nunca no meio de uma apresentação) — nesse momento o app reabre sozinho, então não estranhe se a janela "piscar" ao fechar depois de uma apresentação.

### Modo Office Remote (Windows) — leitura real do Office via COM

No Windows, o Imago sobe automaticamente a ponte `office-bridge.ps1`
(PowerShell + COM). Com ela o app do celular:

- lê o slide **realmente ativo** no PowerPoint (não dessincroniza se você usar o teclado do PC);

- mostra título, notas, seções, slides ocultos, mídia do slide, cronômetro do PowerPoint e miniaturas
geradas pelo próprio PowerPoint (sem LibreOffice/Poppler);

- tem a aba **Office**: lista de documentos abertos, slides (com ocultar/mostrar), Word (títulos,
comentários, zoom) e Excel (planilhas, nomes, tabelas, gráficos, zoom);

- primeiro/último slide, tela branca e prévia do próximo slide.

Sem PowerPoint aberto (ex.: Prezi) ou fora do Windows, tudo continua funcionando como antes, por teclas.
