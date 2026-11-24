-- Estrutura inicial do atendimento de leads da LFG Imóveis.
-- Escritas acontecem pelas funções do servidor (service role) e por funções
-- RPC dedicadas; o painel lê pelas regras de acesso (RLS) abaixo.

-- Funções internas ficam fora do schema exposto pela API.
create schema if not exists interno;
revoke all on schema interno from public, anon, authenticated;
grant usage on schema interno to authenticated;
alter default privileges in schema interno revoke execute on functions from public;

create type public.lead_status as enum ('novo', 'em_atendimento_ia', 'aguardando_corretor', 'com_corretor', 'encerrado');
create type public.lead_temperatura as enum ('quente', 'morno', 'frio');
create type public.lead_interesse as enum ('compra', 'locacao', 'administrativo', 'outro');
create type public.mensagem_autor as enum ('cliente', 'ia', 'corretor', 'sistema');
create type public.atribuicao_status as enum ('pendente', 'aceita', 'expirada', 'recusada', 'cancelada');
create type public.equipe_papel as enum ('corretor', 'gestor');

-- Equipe --------------------------------------------------------------------

create table public.corretores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  whatsapp text unique,
  creci text,
  usuario_id uuid unique references auth.users (id) on delete set null,
  papel public.equipe_papel not null default 'corretor',
  no_rodizio boolean not null default true,
  de_plantao boolean not null default false,
  ordem_rodizio integer,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
comment on column public.corretores.whatsapp is 'Só dígitos, com DDI e DDD. Ex.: 5567999999999.';
comment on column public.corretores.de_plantao is 'Só corretores de plantão recebem leads no rodízio.';

-- Estoque (espelho do Univen) -------------------------------------------------

create table public.imoveis (
  codigo text primary key,
  referencia text,
  tipo text,
  categoria text,
  finalidade text,
  venda boolean,
  locacao boolean,
  valor_venda numeric(14, 2),
  valor_locacao numeric(14, 2),
  valor_promocional numeric(14, 2),
  valor_condominio numeric(14, 2),
  valor_iptu numeric(14, 2),
  dormitorios integer,
  suites integer,
  banheiros integer,
  vagas integer,
  area_construida numeric(14, 2),
  area_terreno numeric(14, 2),
  area_util numeric(14, 2),
  endereco text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  uf text,
  cep text,
  latitude double precision,
  longitude double precision,
  titulo text,
  descricao text,
  link_site text,
  foto_principal text,
  fotos text[] not null default '{}',
  aceita_financiamento smallint,
  aceita_pet boolean,
  mobiliado boolean,
  caracteristicas jsonb not null default '{}',
  ativo boolean not null default true,
  atualizado_univen date,
  sincronizado_em timestamptz not null default now(),
  inativado_em timestamptz
);
comment on column public.imoveis.codigo is 'Codigoimovel no Univen.';
comment on column public.imoveis.referencia is 'Referência exibida no site e nos anúncios. Ex.: CA00742.';
comment on column public.imoveis.ativo is 'Situação "Ativo" no Univen = disponível. Presente no XML de integração = ativo; ao sair do XML vira false.';
comment on column public.imoveis.aceita_financiamento is 'Código bruto do Univen: 1 sim, 0 não. O valor 2 aparece no XML com significado ainda não confirmado.';
comment on column public.imoveis.caracteristicas is 'Demais campos preenchidos do Univen (piscina, churrasqueira...), sem dados administrativos.';
create index imoveis_busca_idx on public.imoveis (ativo, cidade, bairro);
create index imoveis_referencia_idx on public.imoveis (referencia);

-- Leads e conversas -----------------------------------------------------------

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  whatsapp text not null unique,
  nome text,
  origem text,
  campanha text,
  status public.lead_status not null default 'novo',
  temperatura public.lead_temperatura,
  interesse public.lead_interesse,
  ficha jsonb not null default '{}',
  resumo text,
  imovel_codigo text references public.imoveis (codigo) on delete set null,
  corretor_id uuid references public.corretores (id) on delete set null,
  ia_ativa boolean not null default true,
  ultima_mensagem_cliente_em timestamptz,
  enviado_crm_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on column public.leads.ficha is 'Respostas da qualificação: região, orçamento, quartos, forma de pagamento, urgência.';
comment on column public.leads.ultima_mensagem_cliente_em is 'Abre a janela de 24 horas do WhatsApp para mensagens livres.';
create index leads_corretor_idx on public.leads (corretor_id);
create index leads_status_idx on public.leads (status);
create index leads_imovel_idx on public.leads (imovel_codigo);

create table public.mensagens (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  autor public.mensagem_autor not null,
  corretor_id uuid references public.corretores (id) on delete set null,
  tipo text not null default 'texto',
  conteudo text,
  midia_url text,
  whatsapp_id text unique,
  status_entrega text,
  criado_em timestamptz not null default now()
);
comment on column public.mensagens.whatsapp_id is 'ID da mensagem no WhatsApp; evita gravar duas vezes quando a Meta reenvia o aviso.';
create index mensagens_lead_idx on public.mensagens (lead_id, criado_em);
create index mensagens_corretor_idx on public.mensagens (corretor_id);

-- Rodízio ---------------------------------------------------------------------

create table public.atribuicoes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  corretor_id uuid not null references public.corretores (id) on delete cascade,
  status public.atribuicao_status not null default 'pendente',
  oferecida_em timestamptz not null default now(),
  prazo_em timestamptz not null,
  respondida_em timestamptz
);
create unique index atribuicoes_uma_pendente_por_lead on public.atribuicoes (lead_id) where status = 'pendente';
create index atribuicoes_prazo_idx on public.atribuicoes (prazo_em) where status = 'pendente';
create index atribuicoes_corretor_idx on public.atribuicoes (corretor_id);

-- Configurações e acompanhamento --------------------------------------------

create table public.configuracoes (
  chave text primary key,
  valor jsonb not null,
  descricao text,
  atualizado_em timestamptz not null default now()
);

insert into public.configuracoes (chave, valor, descricao) values
  ('prazo_rodizio_minutos', '5', 'Minutos que o corretor tem para assumir o lead antes de ele passar ao próximo. Provisório até a LFG definir.'),
  ('retomada_minutos', '[30, 300]', 'Minutos de silêncio do cliente antes de cada tentativa de retomada.'),
  ('perguntas_obrigatorias', '["interesse", "regiao", "orcamento"]', 'Campos da ficha que a IA preenche antes de passar o lead ao corretor. Lead quente segue antes.');

create table public.sincronizacoes (
  id bigint generated always as identity primary key,
  iniciada_em timestamptz not null default now(),
  finalizada_em timestamptz,
  sucesso boolean,
  imoveis_no_xml integer,
  inativados integer,
  erro text
);
comment on table public.sincronizacoes is 'Histórico das leituras do XML do Univen.';

-- Atualiza leads.atualizado_em a cada alteração.
create function interno.tocar_atualizado_em() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

create trigger leads_atualizado_em
  before update on public.leads
  for each row execute function interno.tocar_atualizado_em();

-- Regras de acesso (RLS) ------------------------------------------------------

create function interno.meu_corretor_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.corretores where usuario_id = (select auth.uid()) and ativo;
$$;

create function interno.sou_gestor() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.corretores
    where usuario_id = (select auth.uid()) and ativo and papel = 'gestor'
  );
$$;

-- Gestor vê todos os leads; corretor vê os seus e os que estão oferecidos a ele.
create function interno.posso_ver_lead(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select interno.sou_gestor()
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id and l.corretor_id = interno.meu_corretor_id()
    )
    or exists (
      select 1 from public.atribuicoes a
      where a.lead_id = p_lead_id and a.status = 'pendente' and a.corretor_id = interno.meu_corretor_id()
    );
$$;

grant execute on function interno.meu_corretor_id() to authenticated;
grant execute on function interno.sou_gestor() to authenticated;
grant execute on function interno.posso_ver_lead(uuid) to authenticated;

alter table public.corretores enable row level security;
alter table public.imoveis enable row level security;
alter table public.leads enable row level security;
alter table public.mensagens enable row level security;
alter table public.atribuicoes enable row level security;
alter table public.configuracoes enable row level security;
alter table public.sincronizacoes enable row level security;

create policy "Equipe vê a equipe" on public.corretores
  for select to authenticated using ((select interno.meu_corretor_id()) is not null);
create policy "Gestor cadastra a equipe" on public.corretores
  for insert to authenticated with check ((select interno.sou_gestor()));
create policy "Gestor altera a equipe" on public.corretores
  for update to authenticated using ((select interno.sou_gestor())) with check ((select interno.sou_gestor()));

create policy "Equipe vê o estoque" on public.imoveis
  for select to authenticated using ((select interno.meu_corretor_id()) is not null);

create policy "Equipe vê os leads permitidos" on public.leads
  for select to authenticated using (interno.posso_ver_lead(id));

create policy "Equipe vê as mensagens dos leads permitidos" on public.mensagens
  for select to authenticated using (interno.posso_ver_lead(lead_id));

create policy "Corretor vê suas atribuições" on public.atribuicoes
  for select to authenticated
  using ((select interno.sou_gestor()) or corretor_id = (select interno.meu_corretor_id()));

create policy "Equipe vê as configurações" on public.configuracoes
  for select to authenticated using ((select interno.meu_corretor_id()) is not null);
create policy "Gestor altera as configurações" on public.configuracoes
  for update to authenticated using ((select interno.sou_gestor())) with check ((select interno.sou_gestor()));

create policy "Equipe vê as sincronizações" on public.sincronizacoes
  for select to authenticated using ((select interno.meu_corretor_id()) is not null);
