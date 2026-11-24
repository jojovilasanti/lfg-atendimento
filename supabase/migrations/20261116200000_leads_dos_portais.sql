-- Leads que chegam dos portais (hoje: Grupo OLX = ZAP Imóveis, Viva Real e OLX).
-- A função portais recebe, guarda aqui o pedido inteiro, liga ao imóvel e ao lead,
-- avisa o corretor dos cliques no WhatsApp / telefone visto, manda o
-- pré-atendimento da Thais e repassa o mesmo lead ao Univen durante a transição.
create table public.leads_portais (
  id bigint generated always as identity primary key,
  portal text not null check (portal ~ '^[a-z_]{2,30}$'),
  -- Código do lead no portal: o mesmo lead reenviado não é processado duas vezes.
  origem_lead_id text not null,
  tipo text,
  imovel_codigo text references public.imoveis (codigo) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  clique_id bigint references public.cliques_whatsapp (id) on delete set null,
  nome text,
  email text,
  telefone text,
  mensagem text,
  pedido jsonb not null,
  -- O que aconteceu: pré-atendimento enviado, pulado (cliente já em conversa) ou passado ao corretor.
  contato text,
  repasse_status text,
  repasse_tentativas integer not null default 0,
  repassado_em timestamptz,
  recebido_em timestamptz not null default now(),
  unique (portal, origem_lead_id)
);

create index leads_portais_recebido on public.leads_portais (recebido_em desc);
create index leads_portais_repasse on public.leads_portais (repasse_status) where repassado_em is null;

alter table public.leads_portais enable row level security;

create policy "Gestor vê os leads dos portais" on public.leads_portais
  for select to authenticated
  using ((select interno.sou_gestor()));

grant select on public.leads_portais to authenticated;

-- Configuração dos portais: para onde repassar (Univen) e o modelo do pré-atendimento.
insert into public.configuracoes (chave, valor, descricao) values (
  'portais',
  jsonb_build_object(
    'grupo_olx', jsonb_build_object(
      'ativo', true,
      'repassar_para', 'https://buscaimo.com.br:9899/lead/42115'
    ),
    'pre_atendimento', jsonb_build_object(
      'modelo', 'contato_portal',
      'texto', 'Olá! Aqui é a Thais, assistente virtual da LFG Imóveis. Recebemos seu interesse no imóvel {{1}} pelo portal de imóveis. Posso te enviar mais detalhes ou ajudar a agendar uma visita?',
      'exemplo', 'CA00613, casa no São Francisco'
    )
  ),
  'Leads dos portais: repasse ao Univen e modelo do pré-atendimento da Thais'
) on conflict (chave) do nothing;
