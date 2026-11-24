# LFG Atendimento — guia para quem desenvolve com o Claude Code

Sistema da LFG Imóveis (Campo Grande/MS): CRM próprio, atendimento por IA no
WhatsApp (a assistente se chama **Thais**), painel da equipe, site da
imobiliária e feeds para os portais. O `README.md` descreve cada parte em
detalhe; este arquivo traz as regras de trabalho e o que é mais recente.

## Idioma e estilo

- Tudo em **português do Brasil**: conversa, textos de tela, comentários, nomes
  de funções e variáveis (`salvar_imovel`, `ehVisita`, `aoFechar`). Siga o padrão.
- Textos para a equipe: frases curtas e diretas, sem jargão técnico.
- Fuso: `America/Campo_Grande` (configurável em Configurações gerais).

## Mapa

| Parte | Onde | Como publica |
|---|---|---|
| Banco (Postgres, RLS, RPCs, cron) | `supabase/migrations/` | migração no projeto `nlbonjxmzmwsyuirxnzu` |
| Funções (Deno) | `supabase/functions/` (`_shared/` é comum) | deploy de cada função |
| Painel (React + Vite) | `painel/` | `bash scripts/publicar-painel.sh` → https://lfg.jojodigitals.com |
| Site (Python estático) | `vps/site/` | `bash scripts/instalar-site.sh` → https://site.lfg.jojodigitals.com |
| Transcrição de áudio | `vps/transcricao/` | `bash scripts/instalar-transcricao.sh` |

- Painel local: `cd painel && npm install && npm run dev` (usa o **banco de
  produção**; o login é o de cada pessoa).
- Site local: `python vps/site/gerar.py --saida <pasta> --forcar`.
- Thais sem WhatsApp: `node scripts/conversar.mjs <cliente>` (função
  `simulador`; leads `sim-<nome>`, nunca misturados com reais).
- Segredos: `.env.local` (fora do git) e segredos das Edge Functions no Supabase.
  Nunca escreva token, chave ou senha no código, no git ou no chat.

## Regras combinadas com o gestor (não quebre)

1. **Nada em produção sem o OK explícito do gestor**: migração, deploy de
   função, publicação do painel ou do site. Teste antes e mostre o resultado.
2. **Migração**: teste antes num bloco `begin; ... rollback;` (ou com um
   `raise exception` no fim de um `do $$` para desfazer tudo). Crie o arquivo
   em `supabase/migrations/AAAAMMDDHHMMSS_nome.sql` com o mesmo texto aplicado.
3. **Leads reais não se mexe**: só leitura. Teste com o simulador (`sim-*`) e
   apague os dados de teste depois.
4. **Modelos de mensagem da Meta** (templates do WhatsApp): texto só com o OK
   do gestor. Configurações da conta da Meta e do firewall são dele.
5. **Dados pessoais**: nomes e telefones de clientes vistos em prints ou no
   Univen nunca entram no sistema, no código ou nos testes.
6. **Commit só quando pedido.** Trabalhe em um ramo e abra pull request.
7. A IA nunca diz ao cliente o nome do corretor que vai atender, e nunca manda
   relatório interno ao cliente (filtros em `_shared/agente.ts`).

## Armadilhas conhecidas

- **Deploy de função**: as funções importam `../_shared/*.ts`. Ao publicar
  pelo conector do Supabase, mande **todos** os arquivos que ela usa (inclusive
  os de `_shared`). `simulador` e `whatsapp` usam o mesmo `_shared`; publique
  os dois juntos quando mexer no agente.
- **API do Claude**: mensagem `role: "system"` no meio da conversa só pode vir
  depois de uma mensagem `user`. Pedidos de correção depois de uma resposta da
  IA vão como `user` com "(Aviso do sistema: ...)".
- **Publicar o painel no Windows**: pare o `npm run dev` antes (EPERM no `npm ci`).
- **Cores do site** são calculadas em dois lugares que precisam andar juntos:
  `vps/site/gerar.py` e `painel/src/siteTema.js` (prévia). O mesmo vale para as
  seções da página inicial.
- **Univen**: o estoque vem do XML do Univen a cada 15 min; imóveis com
  `origem = 'univen'` são só de leitura aqui (a sincronização sobrescreve).
  Ajustes que precisam sobreviver ficam em tabelas à parte
  (ex.: `imoveis_ajustes_portal`).
- **Permissões**: telas por perfil em `painel/src/App.jsx` (`SO_GESTAO`,
  `SO_GESTOR_PLENO`...) **e** no banco (RLS + `interno.sou_gestor()`,
  `interno.sou_gestor_pleno()`). Mude os dois.
- **Botão X**: popups usam `Janela` (`painel/src/crm.jsx`), que já traz X, Esc e
  toque fora. Para menus, `BotaoFechar`, `useFecharComEsc` e
  `useFecharAoTocarFora` em `comum.jsx`.

## Partes recentes (ainda não estão no README)

- **Campanhas da Thais** (`campanhas_ia`, Configurações → Campanhas da Thais):
  base de conhecimento por campanha (ex.: Atmosphere/Plaenge). O lead é
  reconhecido pelas palavras no anúncio ou na mensagem (`_shared/campanhas.ts`).
- **Agenda** (`paginas/Agenda.jsx`): toda a equipe vê a agenda pela RPC
  `agenda_da_equipe`. Nome e telefone do cliente só vão para quem pode mexer na
  visita. Aluguel e venda usam a grade de 1 em 1 hora até
  `configuracoes.agenda_visitas.ultimo_inicio`; o horário ocupado mostra quem
  marcou; a exclusão por imóvel no banco impede dois no mesmo horário.
- **Empreendimentos e banners** (`empreendimentos`, `banners_site`): cadastro em
  Marketing → Empreendimentos (gestor e administrativo) e Site → Banners
  (gestor). O site gera `/empreendimentos/` e a página de cada um, com o
  formulário `pedir_informacoes_site` (anônimo, com limites contra robôs), que
  vira lead com a origem "Site – Empreendimento X" e segue o rodízio.
- **Portais** (`portais`, `portal_atualizacoes`, `portal_problemas`,
  `imoveis_ajustes_portal`; tela Estoque → Portais, só gestor): a função
  `feeds` gera o XML do Grupo OLX (VRSync, `feeds/vrsync.ts`) no bucket público
  `feeds`, confere cada imóvel (CEP, 5 fotos JPG, título, descrição, área,
  preço) e procura CEP no ViaCEP. Roda a cada hora (cron `atualizar-portais`)
  ou pelo botão. Os portais ainda leem o feed da Union até o gestor trocar no
  Canal Pro. Chaves na Mão e Imovelweb esperam a especificação do feed.
