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
const config = require('./config');

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

if (require.main === module) {
  main();
}

module.exports = { runWizard: main };
