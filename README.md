# LFG Atendimento

Sistema de atendimento de leads da LFG Imóveis: uma IA (Claude) atende pelo
WhatsApp oficial 24 horas, qualifica o cliente, consulta o estoque do Univen e
passa o lead ao corretor da vez, com prazo para assumir.

## Estrutura

- `supabase/migrations/`: banco de dados (tabelas, regras de acesso, rotinas).
- `supabase/functions/`: funções do servidor (WhatsApp, agente de IA, painel).
- `painel/`: painel da equipe (React + Vite), publicado na VPS da Hostinger.

## Painel

- Endereço: https://lfg.jojodigitals.com (VPS da Hostinger, servidor web Caddy,
  pasta `/var/www/lfg-crm`, fora do Google). O nome da VPS,
  https://srv2083149.hstgr.cloud, só redireciona para lá, mantendo o `#` da tela;
  nele ficam a transcrição e a conversão de áudios, chamadas pelas funções.
- Publicar uma nova versão: `bash scripts/publicar-painel.sh` (com o
  `npm run dev` parado; no Windows o `npm ci` não apaga arquivos em uso).
- Links do painel nos avisos aos corretores: `ENDERECO_PAINEL` em
  `supabase/functions/_shared/rodizio.ts` (função `whatsapp`).
- Endereço novo do painel: registro A para a VPS, um bloco no `vps/Caddyfile`
  (aplicado por `scripts/instalar-site.sh`) e a origem em `ORIGENS_DO_PAINEL`
  da função `painel`, senão o envio de mensagens e áudios é recusado.
- Celular (até 760px): menu fixo embaixo, cabeçalho enxuto, tabelas em cartões e
  o lead em abas (Conversa e Ficha). O corte fica em `estilo.css` e em
  `useEhCelular` (`comum.jsx`).
- Rodar no computador: `cd painel && npm install && npm run dev` (abre em
  http://localhost:5173, usando o mesmo banco de produção).
- Acessos: o gestor cria o login de cada pessoa em Configurações → Equipe e
  acessos. O primeiro gestor usa o código `CONVITE_GESTOR` do `.env.local`,
  que vale uma vez só.

## Projeto Supabase

- Nome: `lfg-atendimento`
- ID: `nlbonjxmzmwsyuirxnzu`
- Região: São Paulo (`sa-east-1`)

## Regras de negócio já definidas

- **Disponibilidade:** um imóvel só está disponível quando a situação dele no
  Univen é "Ativo". O XML de integração do Univen
  (`https://integracaounion.com.br/union/42115/42115.xml`) é gerado na hora e
  lista os imóveis publicados; um imóvel que sai do XML é marcado como inativo.
- **Estoque:** sincronizado do XML a cada 15 minutos.
- **Distribuição:** o lead vai para o **captador do imóvel** de interesse
  (campo Captador do Univen), de plantão ou não. Sem imóvel de interesse, ou
  quando o captador não está na equipe, recusa ou não assume no prazo, o lead
  vai para o **rodízio de plantão** (quem está há mais tempo sem receber lead do
  rodízio). Quem é cada captador na equipe se define em Configurações → Equipe.
  O prazo fica em `configuracoes` (`prazo_rodizio_minutos`) e ainda é provisório.
- **Códigos do Univen:** em 29/10/2026 o Univen trocou o código e o link de todos
  os imóveis. O código antigo fica em `imoveis.codigo_anterior`, e a IA acha o
  imóvel por ele, pela referência ou pelo link (antigo ou novo).

## Aviso ao corretor

- Quando o rodízio oferece um lead, o banco chama a função `avisos` (gatilho em
  `atribuicoes`, via pg_net) e o corretor recebe no WhatsApp a mensagem-modelo
  `novo_lead`, com os botões **Assumir** e **Não posso agora**.
- O toque no botão chega pelo webhook: Assumir passa o lead ao corretor (a IA
  pausa) e manda o link do lead no painel; Não posso agora passa ao próximo.
- O modelo fica em `supabase/functions/_shared/rodizio.ts` e é enviado para
  aprovação da Meta pela função `whatsapp-numero` (ação `criar_modelo_aviso`).
  Mensagens-modelo são cobradas pela Meta: a conta do WhatsApp precisa de uma
  forma de pagamento.
- No rodízio, só recebe lead quem está no rodízio, de plantão e com WhatsApp no
  cadastro. O captador recebe os leads dos próprios imóveis mesmo fora do plantão.

## Acompanhamento da espera e fila do plantão

- A rotina `acompanhar-esperas` (pg_cron, a cada minuto) procura cliente sem
  resposta do corretor: 10 minutos (`configuracoes.acompanhamento_minutos`)
  depois da passagem ou da última mensagem dele, sem mensagem do corretor no
  painel. Depois que o corretor assume, só conta se o cliente escrever de novo.
- O aviso de fila é gravado como mensagem da IA (tipo `acompanhamento`) e sai
  pela função `avisos`. Dentro do horário do escritório
  (`configuracoes.horario_escritorio`) é "a fila está cheia, você é o próximo";
  fora dele, informa o horário. No máximo 3 por dia por cliente e só dentro da
  janela de 24 horas do WhatsApp. Conversas do simulador ficam "simulado".
- Lead que ficou sem corretor de plantão vai para quem ligar o plantão, o mais
  antigo primeiro (gatilho em `corretores`).

## Áudio do corretor

- No painel, com a caixa de resposta vazia, o botão de microfone grava (até 5
  minutos). O navegador grava em WebM, MP4 ou Ogg; a função `painel` (ação
  `enviar_audio`) manda para a VPS converter em Ogg/Opus (`/converter`, mesmo
  serviço da transcrição), guarda no bucket `midias` e envia como áudio pelo
  WhatsApp. A IA pausa no lead e a transcrição fica na mensagem.

## Notificações do painel

- Web Push: o service worker (`painel/public/sw.js`) mostra a notificação mesmo
  com o painel fechado ou minimizado. Cada pessoa ativa no aparelho, pela faixa
  no topo do painel ou em Configurações → Minha conta (lá também há o teste).
- Avisa o corretor do lead e quem está com a oferta aberta quando o cliente
  escreve (gatilho em `mensagens` → função `avisos`), e o corretor quando um lead
  é oferecido a ele. Leads do simulador não notificam.
- No iPhone só funciona com o painel instalado na Tela de Início (Compartilhar →
  Adicionar à Tela de Início). As chaves VAPID são geradas na primeira ativação:
  a pública fica em `configuracoes`, a privada no Vault.
- Ícones do app instalável: `python painel/scripts/gerar-icones.py`.

## Passar o lead para outro corretor (gestor)

- Na ficha do lead, o gestor escolhe o corretor em "Passar para outro corretor"
  (função `passar_lead`). A oferta aberta é cancelada.
- Com aviso: o corretor recebe o `novo_lead` ("encaminhado pela gestão") e tem o
  prazo do rodízio para assumir; se não assumir, o lead segue para o rodízio.
- Direto: quando o gestor já combinou com o corretor, o lead fica com ele na
  hora, sem aviso, e a IA pausa.

## CRM de clientes

O lead é o cliente: o mesmo registro que a Thais atende entra no funil quando um corretor fica com ele (migração `crm_clientes`).

- **Etapas:** A contatar, Em contato, Visita, Proposta, Fechado e Perdido (`leads.etapa`). A primeira mensagem do corretor tira de "A contatar". Fechado pede o valor (opcional), Perdido pede o motivo (lista em `configuracoes.motivos_perda`); os dois encerram o lead e concluem os passos abertos.
- **Cliente encerrado que volta a escrever:** reabre em "A contatar" com o mesmo corretor. Sem corretor ativo, volta para a Thais.
- **Próximos passos (`tarefas`):** com data e lembrete por notificação quando vencem (cron `avisar-tarefas`, função `avisos`). Acompanham o lead se ele mudar de corretor.
- **Histórico (`atividades`):** notas, ligações, visitas, propostas, mudanças de etapa, passos concluídos e imóveis enviados. Não vai para o WhatsApp nem para a IA.
- **Cliente cadastrado à mão (`criar_cliente`):** fica com quem cadastrou (o gestor pode escolher o corretor) e a IA não fala com ele. O número é comparado com e sem o 9; se já existir, o painel avisa em vez de duplicar. O atendimento (`_shared/atendimento.ts`) faz a mesma comparação quando esse cliente escreve.
- **Ficha editável (`editar_cliente`):** a mesma ficha que a Thais preenche.
- **Imóveis compatíveis (`imoveis_compativeis`):** usa a busca da Thais com a ficha do cliente; a região pode ter vários bairros. Enviar manda pelo número oficial (dentro da janela de 24 horas) e pausa a IA no lead.

As telas ficam em `painel/src/paginas/Funil.jsx` e `Negociacao.jsx`. As regras de acesso são as do lead: o corretor vê e mexe só nos dele, o gestor em todos.

## Perfis e permissões

- Gestor vê tudo. Corretor: Início, Leads, Funil, Plantão (ver e entrar/sair), Imóveis (cadastra; edita só o que captou) e Meu perfil (nome, foto, WhatsApp, senha, notificações).
- Só do gestor: Site e Configurações (regras do plantão, equipe e acessos, integrações). A lista fica em `SO_GESTOR` (`painel/src/App.jsx`); quem abre uma dessas telas sem ser gestor, até pelo endereço, volta para o Início.
- No banco (migração `20261110130919_perfis_e_permissoes`): o corretor lê só as configurações `motivos_perda` e `prazo_rodizio_minutos`; perfil próprio por `atualizar_meu_perfil`; equipe por `gestor_atualizar_pessoa` (só gestor, ninguém tira o próprio acesso de gestor, sempre fica um gestor ativo). Fotos no bucket público `perfis`, na pasta do id de cada um.

## Cadastro de imóveis

Menu Imóveis: lista com filtros, ficha e cadastro em 7 etapas (localização, proprietário, características, comodidades, preço, fotos e anúncio). Migrações `20261105202347_cadastro_de_imoveis` e `20261109200208_proprietarios`.

- `origem` separa o que vem do Univen (`univen`) do cadastro próprio (`proprio`). A sincronização só inativa `univen`; o que vem do Univen só pode ser consultado aqui até a troca dos portais.
- `situacao`: rascunho, disponível, reservado, vendido, alugado ou inativo. Só `disponivel` deixa o imóvel `ativo` e vai para a Thais e para o site.
- Tudo grava pela função `salvar_imovel` (captador ou gestor). O rascunho nasce quando a pessoa passa da primeira etapa, e depois cada alteração salva sozinha. Publicar exige bairro, cidade, estado, preço e 1 foto; sair do rascunho exige também proprietário vinculado e as áreas (área construída e área útil; em terreno e área, a área do terreno). O painel não deixa passar das etapas Proprietário e Características sem isso.
- Proprietários em `proprietarios` e `imovel_proprietarios`, fora da tabela `imoveis`: só o gestor, quem cadastrou e o captador do imóvel veem (RLS). Nome completo e telefone são obrigatórios; o telefone é único (com ou sem o 9), e um telefone já cadastrado só ganha o vínculo com o novo imóvel. Gravação só pelas funções `salvar_proprietario`, `proprietario_pelo_telefone` e `desvincular_proprietario` (imóvel publicado não fica sem proprietário). A Thais e o site não leem essas tabelas. Imóveis do Univen não têm proprietário aqui.
- Baixar fotos (ficha do imóvel, `src/fotosDoImovel.js`): .zip ou, no celular, salvar/enviar pelo menu de compartilhar. Com marca d'água, o logo da LFG em branco translúcido é aplicado no aparelho; sem marca, vão os arquivos originais. Só o cadastro próprio tem foto sem marca: as do Univen já chegam marcadas no XML.
- A referência é prefixo do tipo + próximo número (CA00743), e o código interno começa em 90000001. O `link_site` usa o `endereco_site` de Configurações → Site (hoje https://site.lfg.jojodigitals.com); se o endereço mudar, recalcular nos imóveis próprios.
- Fotos no bucket público `imoveis`, reduzidas no aparelho antes do envio: `<codigo>/<uuid>.jpg` (1600 px) e `-mini.jpg` (640 px).
- `ocupacao` e `taxa_administracao` são internos: não vão para a Thais nem para o site.
- A nota de qualidade segue o mínimo do Grupo OLX (5 fotos, título de 10 a 100 caracteres, descrição de 50 a 3000), mais preço e área, e CEP no cadastro próprio.

Ainda não existe: dados do proprietário (vão em tabela separada com acesso restrito, porque `imoveis` é lida por toda a equipe) e envio do cadastro próprio aos portais.

## Site da imobiliária

Páginas estáticas geradas na VPS por `vps/site/gerar.py` (Python sem dependências). O gerador confere a cada minuto a impressão digital dos dados (`public.site_versao`, uns 40 bytes) e só baixa tudo e refaz as páginas quando algo mudou. Se o banco falhar ou vier sem imóveis, o site no ar continua como está. Endereço em teste: https://site.lfg.jojodigitals.com.

- **O que aparece:** o estoque ativo, por `public.site_dados`, que entrega só dados públicos (sem captador, rua, número nem coordenadas). Imóvel que deixa de ser Ativo sai sozinho do site.
- **O que o gestor edita:** a tela Site do painel (só gestor), com prévia ao vivo da página inicial: logo, cores (principal, destaque, links, fundo), letras (moderna, clássica, simples), banner (foto, escurecer, título, subtítulo, alinhamento, busca ou botões), seções da página inicial (ordem, mostrar, títulos, quantos destaques), textos dos botões, sobre, serviços, descrição para o Google, texto de contato, frase do rodapé e contatos. Tudo fica em `configuracoes.site` (imagens no bucket público `site`); sem escolha, vale a aparência da LFG. A conta das cores existe em dois lugares que precisam andar juntos: `gerar.py` e `painel/src/siteTema.js` (prévia).
- **Endereços:** os mesmos do site atual (`/comprar/MS/Campo-Grande/Bairro/casa/código`), para os links antigos valerem na troca de domínio.
- **Contato:** o botão abre o WhatsApp oficial com a referência do imóvel, e a Thais atende.
- **Google:** fora do ar (`noindex` e `robots.txt`) até o gestor ligar "Aparecer no Google". Com a opção ligada e o endereço preenchido, sai também o `sitemap.xml`.
- **Fotos:** continuam no servidor de imagens usado pelo Univen (static.tokkobroker.com), em tamanho cheio. Precisam ir para o nosso armazenamento, com miniaturas, antes de desligar o Univen.

Para instalar ou atualizar: `bash scripts/instalar-site.sh` (aplica também o `vps/Caddyfile`; inclua ali o endereço do site antes). Para ver no computador: `python vps/site/gerar.py --saida <pasta> --forcar`.

## Fotos, áudios e documentos

- O arquivo que o cliente manda é baixado da Meta e guardado no bucket privado
  `midias` do Supabase, numa pasta por cliente. A equipe vê no painel (foto,
  player de áudio, link do PDF) só os arquivos dos leads que pode ver.
- Foto e PDF vão como anexo para a IA (os 4 mais recentes da conversa).
- Áudio é transcrito na VPS (faster-whisper, modelo `small`, em português) e a
  IA lê a transcrição. Um áudio de 1 minuto leva uns 10 segundos.
- Instalar ou atualizar o serviço de transcrição e o Caddy:
  `bash scripts/instalar-transcricao.sh`. O token do serviço fica no Vault do
  Supabase; a VPS guarda só o hash (o script explica como gerar).
- Vídeo é guardado para a equipe, mas a IA não assiste: ela pede para o
  cliente escrever.

## Testar a IA sem WhatsApp

A função `simulador` recebe mensagens como se fossem de um cliente. Os leads
simulados usam o número `sim-<nome>` e não se misturam com os reais.

```bash
node scripts/conversar.mjs ana
```

Para testar mídia, envie `midia_url` (endereço de uma foto, áudio ou PDF) no
corpo do pedido ao simulador; `midia_tipo` corrige o tipo quando o site não
informa (ex.: `audio/ogg`).

O endereço e a chave do simulador ficam em `.env.local` (fora do git). No banco
fica só o hash da chave, na tabela `chaves_acesso`.

## Segredos

Tokens (Claude, WhatsApp, Univen) ficam nos segredos das Edge Functions do
Supabase, nunca no código nem no git. A IA precisa do segredo
`ANTHROPIC_API_KEY`.

## Configurações gerais (gestor)

Em Configurações → Configurações gerais, guardadas em `configuracoes.empresa` e salvas pela função `salvar_empresa`:

- **Empresa:** nome e logo. Aparecem na tela de entrada, no topo do painel e no site. A logo própria da aba Site só vale se estiver preenchida.
- **Fuso horário:** padrão Campo Grande. Vale para o painel (`definirFuso` em `comum.jsx`), para o horário do escritório (`interno.fuso()`) e para a IA (`fuso_da_empresa`, lido em `agente.ts`).
- **Marca d'água:** liga e desliga, imagem, tamanho, posição e transparência.
  - Entra só nas fotos dos imóveis cadastrados aqui, em dois lugares: no site, desenhada por cima da foto, e ao baixar pelo painel, gravada na foto.
  - As fotos do Univen já têm a marca de lá.
- **Rodapé da descrição:** texto no fim de toda descrição no site. `[[codigo]]` vira o código do imóvel e `[[captador]]` vira o nome de quem captou.
- **Chave da API:**
  - `gerar_chave_api` devolve a chave uma única vez; o banco guarda só o hash, em `chaves_acesso.api_imoveis`.
  - Endereço: `GET /functions/v1/api-imoveis`, com o cabeçalho `x-api-key`.
  - Opções: mostrar informações internas e mostrar imóveis indisponíveis. Rascunhos nunca saem.
