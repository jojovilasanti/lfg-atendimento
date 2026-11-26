-- Módulo de Locação, Etapa 4a: contratos (cadastro, simulação, ativação).
--
-- * contratos: todos os parâmetros da tela de cadastro. Situação: rascunho
--   (pode ficar incompleto, não entra em nada), ativo, rescindido, encerrado.
-- * contrato_partes: locatários e fiadores (escolhidos no cadastro) e os
--   locadores (copiados do imóvel administrado ao ativar, com o percentual).
-- * contrato_periodos: os períodos do contrato, gerados ao ativar pela mesma
--   conta da simulação (interno.calcular_periodos).
-- * Ao ativar: confere os obrigatórios, numera, gera os períodos, calcula
--   término e próximo reajuste e guarda a cópia dos dados (snapshot).
-- Só interno.acessa_locacao(); escrita só pelas funções, com auditoria.

create sequence if not exists public.locacao_contrato_numero start 1;

create table if not exists public.contratos (
  id uuid primary key default gen_random_uuid(),
  numero bigint unique,
  situacao text not null default 'rascunho' check (situacao in ('rascunho', 'ativo', 'rescindido', 'encerrado')),
  titulo_rascunho text,
  imovel_codigo text references public.imoveis_locacao (imovel_codigo) on update cascade,
  regime_tributario text not null default 'nao_informado',
  preferencia_pagamento text not null default 'indiferente' check (preferencia_pagamento in ('indiferente', 'boleto', 'pix', 'deposito')),
  desconto_pontualidade numeric(7,4) not null default 0 check (desconto_pontualidade >= 0 and desconto_pontualidade <= 100),
  finalidade text not null default 'residencial' check (finalidade in ('residencial', 'comercial', 'industrial', 'temporada', 'rural')),
  valor_inicial numeric(14,2) check (valor_inicial is null or valor_inicial > 0),
  valor_atual numeric(14,2),
  indice text not null default 'IGP-M' check (indice in ('IGP-M', 'IPCA', 'INPC', 'IVAR', 'IGP-DI', 'FIXO')),
  indice_fixo numeric(9,4),
  controle text,
  garantia_aluguel boolean not null default false,
  garantia_aluguel_meses int check (garantia_aluguel_meses is null or garantia_aluguel_meses >= 0),
  inicio date,
  prazo_meses int check (prazo_meses is null or prazo_meses between 1 and 600),
  reajuste_meses int check (reajuste_meses is null or reajuste_meses between 1 and 120),
  dia_inicio_periodo int check (dia_inicio_periodo is null or dia_inicio_periodo between 1 and 31),
  dia_cobranca int check (dia_cobranca is null or dia_cobranca between 1 and 31),
  cobranca_referencia text not null default 'apos_periodo' check (cobranca_referencia in ('apos_periodo', 'no_periodo')),
  dia_repasse int check (dia_repasse is null or dia_repasse between 1 and 31),
  repasse_referencia text not null default 'apos_periodo' check (repasse_referencia in ('apos_periodo', 'no_periodo')),
  taxa_administracao numeric(14,4) check (taxa_administracao is null or taxa_administracao >= 0),
  taxa_base text not null default 'percentual_aluguel' check (taxa_base in ('percentual_aluguel', 'valor_fixo', 'percentual_cobranca')),
  taxa_proporcional boolean not null default true,
  taxa_intermediacao numeric(9,4) check (taxa_intermediacao is null or taxa_intermediacao >= 0),
  multa_percentual numeric(9,4) not null default 10,
  multa_forma text not null default 'integral' check (multa_forma in ('integral', 'diaria_30')),
  multa_base text not null default 'total' check (multa_base in ('total', 'aluguel')),
  multa_a_partir_dia int not null default 1,
  multa_pj_omitir boolean not null default false,
  juros_percentual numeric(9,4) not null default 0.033,
  juros_periodo text not null default 'dia' check (juros_periodo in ('dia', 'mes')),
  juros_a_partir_dia int not null default 1,
  irrf_modo text not null default 'percentual' check (irrf_modo in ('percentual', 'dividir', 'nao_calcular')),
  garantia_tipo text not null default 'nenhuma' check (garantia_tipo in ('nenhuma', 'seguro_fianca_vista', 'seguro_fianca_parcelado', 'caucao', 'titulo_capitalizacao', 'carta_fianca', 'deposito', 'cartao_credito', 'fiador')),
  garantia_dados jsonb not null default '{}',
  supervisor_id uuid references public.corretores (id) on delete set null,
  comissao_supervisor numeric(9,4) not null default 0,
  clausula_pintura boolean not null default false,
  clausula_meses boolean not null default false,
  unidade_id uuid references public.locacao_unidades (id) on delete set null,
  liberado_lancamentos boolean not null default true,
  fora_do_lote boolean not null default false,
  contrato_parcial boolean not null default false,
  movimentacao_desde date,
  movimentacao_proporcional boolean not null default false,
  ultimo_reajuste_em date,
  valor_vigente numeric(14,2),
  meses_para_reajuste int,
  multa_rescisoria_alugueis numeric(5,2) not null default 3,
  observacoes text,
  termino date,
  proximo_reajuste date,
  snapshot jsonb,
  lead_id uuid references public.leads (id) on delete set null,
  origem text not null default 'painel' check (origem in ('painel', 'unilocweb')),
  origem_codigo text,
  criado_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ativado_em timestamptz,
  ativado_por uuid references public.corretores (id) on delete set null
);
create index if not exists contratos_imovel on public.contratos (imovel_codigo);
create index if not exists contratos_situacao on public.contratos (situacao);
create unique index if not exists contratos_origem on public.contratos (origem, origem_codigo) where origem_codigo is not null;
-- Um imóvel não pode ter dois contratos ativos ao mesmo tempo.
create unique index if not exists contratos_um_ativo_por_imovel on public.contratos (imovel_codigo) where situacao = 'ativo';
alter table public.contratos enable row level security;
revoke all on public.contratos from anon;
drop policy if exists "Gestão vê os contratos" on public.contratos;
create policy "Gestão vê os contratos" on public.contratos for select to authenticated using ((select interno.acessa_locacao()));
drop trigger if exists contratos_auditoria on public.contratos;
create trigger contratos_auditoria after insert or update or delete on public.contratos for each row execute function interno.auditar_locacao();

create table if not exists public.contrato_partes (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid not null references public.contratos (id) on delete cascade,
  pessoa_id uuid not null references public.pessoas (id),
  papel text not null check (papel in ('locatario', 'fiador', 'locador')),
  percentual numeric(7,4),
  favorecido_id uuid references public.pessoas (id),
  ordem int not null default 0,
  unique (contrato_id, pessoa_id, papel)
);
create index if not exists contrato_partes_pessoa on public.contrato_partes (pessoa_id);
alter table public.contrato_partes enable row level security;
revoke all on public.contrato_partes from anon;
drop policy if exists "Gestão vê as partes dos contratos" on public.contrato_partes;
create policy "Gestão vê as partes dos contratos" on public.contrato_partes for select to authenticated using ((select interno.acessa_locacao()));
drop trigger if exists contrato_partes_auditoria on public.contrato_partes;
create trigger contrato_partes_auditoria after insert or update or delete on public.contrato_partes for each row execute function interno.auditar_locacao();

create table if not exists public.contrato_periodos (
  contrato_id uuid not null references public.contratos (id) on delete cascade,
  numero int not null,
  inicio date not null,
  fim date not null,
  vencimento date not null,
  repasse date not null,
  valor numeric(14,2) not null,
  proporcional boolean not null default false,
  reajuste boolean not null default false,
  anterior_a_movimentacao boolean not null default false,
  primary key (contrato_id, numero)
);
alter table public.contrato_periodos enable row level security;
revoke all on public.contrato_periodos from anon;
drop policy if exists "Gestão vê os períodos" on public.contrato_periodos;
create policy "Gestão vê os períodos" on public.contrato_periodos for select to authenticated using ((select interno.acessa_locacao()));

-- Datas -------------------------------------------------------------------------
-- O dia `p_dia` do mês de `p_data`; num mês mais curto, o último dia do mês.
create or replace function interno.dia_do_mes(p_data date, p_dia int)
 returns date language sql immutable set search_path to '' as $$
  select (date_trunc('month', p_data)::date + (least(p_dia, extract(day from (date_trunc('month', p_data) + interval '1 month - 1 day'))::int) - 1))::date;
$$;

-- Primeira data com o dia `p_dia` a partir de `p_desde` (incluindo ou não o próprio dia).
create or replace function interno.proxima_data_no_dia(p_desde date, p_dia int, p_incluir boolean)
 returns date language plpgsql immutable set search_path to '' as $$
declare
  v date := interno.dia_do_mes(p_desde, p_dia);
begin
  if v < p_desde or (not p_incluir and v = p_desde) then
    v := interno.dia_do_mes((date_trunc('month', p_desde) + interval '1 month')::date, p_dia);
  end if;
  return v;
end;
$$;

-- Períodos do contrato (a simulação e a ativação usam a mesma conta).
-- p: inicio, prazo_meses, reajuste_meses, dia_inicio_periodo, dia_cobranca,
-- cobranca_referencia, dia_repasse, repasse_referencia, valor_inicial,
-- taxa_proporcional (aluguel proporcional nos períodos quebrados),
-- movimentacao_desde, valor_vigente.
create or replace function interno.calcular_periodos(p jsonb)
 returns table (numero int, inicio date, fim date, vencimento date, repasse date, valor numeric, proporcional boolean, reajuste boolean, anterior_a_movimentacao boolean)
 language plpgsql
 immutable
 set search_path to ''
as $$
declare
  v_inicio date := (p ->> 'inicio')::date;
  v_prazo int := (p ->> 'prazo_meses')::int;
  v_reajuste int := (p ->> 'reajuste_meses')::int;
  v_dia_periodo int := coalesce(nullif(p ->> 'dia_inicio_periodo', '')::int, extract(day from (p ->> 'inicio')::date)::int);
  v_dia_cobranca int := (p ->> 'dia_cobranca')::int;
  v_cob_apos boolean := coalesce(p ->> 'cobranca_referencia', 'apos_periodo') = 'apos_periodo';
  v_dia_repasse int := (p ->> 'dia_repasse')::int;
  v_rep_apos boolean := coalesce(p ->> 'repasse_referencia', 'apos_periodo') = 'apos_periodo';
  v_valor numeric := (p ->> 'valor_inicial')::numeric;
  v_proporcional boolean := coalesce((p ->> 'taxa_proporcional')::boolean, true);
  v_movimento date := nullif(p ->> 'movimentacao_desde', '')::date;
  v_vigente numeric := nullif(p ->> 'valor_vigente', '')::numeric;
  v_termino date;
  v_ini date;
  v_fim date;
  v_fronteira date;
  v_ciclo int;
  v_dias int;
  v_n int := 0;
  v_proximo_reajuste date;
  v_marca boolean;
begin
  if v_inicio is null or v_prazo is null or v_reajuste is null or v_dia_cobranca is null or v_dia_repasse is null or v_valor is null then
    return;
  end if;
  v_termino := (v_inicio + make_interval(months => v_prazo))::date - 1;
  v_proximo_reajuste := (v_inicio + make_interval(months => v_reajuste))::date;
  v_ini := v_inicio;
  while v_ini <= v_termino and v_n < 600 loop
    v_n := v_n + 1;
    v_fronteira := interno.proxima_data_no_dia(v_ini, v_dia_periodo, false);
    v_fim := least(v_fronteira - 1, v_termino);
    -- Tamanho do período cheio: do dia do início do mês anterior à fronteira.
    v_ciclo := v_fronteira - interno.dia_do_mes((v_fronteira - interval '1 month')::date, v_dia_periodo);
    v_dias := v_fim - v_ini + 1;
    v_marca := false;
    if v_ini >= v_proximo_reajuste then
      v_marca := true;
      while v_proximo_reajuste <= v_ini loop
        v_proximo_reajuste := (v_proximo_reajuste + make_interval(months => v_reajuste))::date;
      end loop;
    end if;
    numero := v_n;
    inicio := v_ini;
    fim := v_fim;
    proporcional := v_dias < v_ciclo;
    reajuste := v_marca;
    anterior_a_movimentacao := v_movimento is not null and v_fim < v_movimento;
    valor := case when v_movimento is not null and v_vigente is not null and v_fim >= v_movimento then v_vigente else v_valor end;
    if proporcional and v_proporcional then
      valor := round(valor * v_dias / v_ciclo, 2);
    end if;
    vencimento := case when v_cob_apos then interno.proxima_data_no_dia(v_fim, v_dia_cobranca, false)
                       else least(interno.proxima_data_no_dia(v_ini, v_dia_cobranca, true), greatest(v_fim, v_ini)) end;
    repasse := case when v_rep_apos then interno.proxima_data_no_dia(v_fim, v_dia_repasse, false)
                    else least(interno.proxima_data_no_dia(v_ini, v_dia_repasse, true), greatest(v_fim, v_ini)) end;
    -- O repasse nunca vem antes do vencimento da cobrança.
    if repasse < vencimento then
      repasse := interno.proxima_data_no_dia(vencimento, v_dia_repasse, true);
    end if;
    return next;
    v_ini := v_fim + 1;
  end loop;
end;
$$;

-- Simulação para a tela (mesma conta da ativação).
create or replace function public.simular_periodos(p_dados jsonb)
 returns table (numero int, inicio date, fim date, vencimento date, repasse date, valor numeric, proporcional boolean, reajuste boolean, anterior_a_movimentacao boolean)
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  return query select * from interno.calcular_periodos(p_dados);
end;
$$;
revoke all on function public.simular_periodos(jsonb) from public, anon;
grant execute on function public.simular_periodos(jsonb) to authenticated;

-- Salvar (rascunho ou contrato ativo) ----------------------------------------------
-- p_dados: os campos do formulário; p_locatarios e p_fiadores: ids de pessoas.
-- Contrato ativo: imóvel, início, prazo, dias e valores ficam travados (mudam por
-- reajuste, aditamento ou rescisão nas próximas etapas).
create or replace function public.salvar_contrato(p_id uuid, p_dados jsonb, p_locatarios uuid[], p_fiadores uuid[])
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_atual public.contratos;
  v_id uuid;
  v_ativo boolean := false;
  d jsonb := coalesce(p_dados, '{}');
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if p_id is not null then
    select * into v_atual from public.contratos where id = p_id for update;
    if v_atual.id is null then raise exception 'Contrato não encontrado'; end if;
    if v_atual.situacao in ('rescindido', 'encerrado') then raise exception 'Contrato encerrado não pode ser alterado'; end if;
    v_ativo := v_atual.situacao = 'ativo';
  end if;
  if nullif(d ->> 'supervisor_id', '') is not null and not exists (
    select 1 from public.corretores c where c.id = (d ->> 'supervisor_id')::uuid and c.ativo and c.papel in ('gestor', 'administrativo')) then
    raise exception 'O supervisor tem que ser da gestão (gestor ou administrativo)';
  end if;
  if nullif(d ->> 'imovel_codigo', '') is not null and not exists (select 1 from public.imoveis_locacao where imovel_codigo = d ->> 'imovel_codigo') then
    raise exception 'Imóvel não está em Imóveis administrados';
  end if;
  if exists (select 1 from unnest(coalesce(p_locatarios, '{}') || coalesce(p_fiadores, '{}')) x where not exists (select 1 from public.pessoas p where p.id = x)) then
    raise exception 'Locatário ou fiador não encontrado';
  end if;

  if p_id is null then
    insert into public.contratos (criado_por) values (interno.meu_corretor_id()) returning id into v_id;
  else
    v_id := p_id;
  end if;

  update public.contratos c set
    titulo_rascunho = nullif(trim(d ->> 'titulo_rascunho'), ''),
    imovel_codigo = case when v_ativo then c.imovel_codigo else nullif(d ->> 'imovel_codigo', '') end,
    regime_tributario = coalesce(nullif(d ->> 'regime_tributario', ''), 'nao_informado'),
    preferencia_pagamento = coalesce(nullif(d ->> 'preferencia_pagamento', ''), 'indiferente'),
    desconto_pontualidade = coalesce(nullif(d ->> 'desconto_pontualidade', '')::numeric, 0),
    finalidade = coalesce(nullif(d ->> 'finalidade', ''), 'residencial'),
    valor_inicial = case when v_ativo then c.valor_inicial else nullif(d ->> 'valor_inicial', '')::numeric end,
    indice = coalesce(nullif(d ->> 'indice', ''), 'IGP-M'),
    indice_fixo = nullif(d ->> 'indice_fixo', '')::numeric,
    controle = nullif(trim(d ->> 'controle'), ''),
    garantia_aluguel = coalesce((d ->> 'garantia_aluguel')::boolean, false),
    garantia_aluguel_meses = nullif(d ->> 'garantia_aluguel_meses', '')::int,
    inicio = case when v_ativo then c.inicio else nullif(d ->> 'inicio', '')::date end,
    prazo_meses = case when v_ativo then c.prazo_meses else nullif(d ->> 'prazo_meses', '')::int end,
    reajuste_meses = case when v_ativo then c.reajuste_meses else nullif(d ->> 'reajuste_meses', '')::int end,
    dia_inicio_periodo = case when v_ativo then c.dia_inicio_periodo else nullif(d ->> 'dia_inicio_periodo', '')::int end,
    dia_cobranca = case when v_ativo then c.dia_cobranca else nullif(d ->> 'dia_cobranca', '')::int end,
    cobranca_referencia = case when v_ativo then c.cobranca_referencia else coalesce(nullif(d ->> 'cobranca_referencia', ''), 'apos_periodo') end,
    dia_repasse = case when v_ativo then c.dia_repasse else nullif(d ->> 'dia_repasse', '')::int end,
    repasse_referencia = case when v_ativo then c.repasse_referencia else coalesce(nullif(d ->> 'repasse_referencia', ''), 'apos_periodo') end,
    taxa_administracao = nullif(d ->> 'taxa_administracao', '')::numeric,
    taxa_base = coalesce(nullif(d ->> 'taxa_base', ''), 'percentual_aluguel'),
    taxa_proporcional = case when v_ativo then c.taxa_proporcional else coalesce((d ->> 'taxa_proporcional')::boolean, true) end,
    taxa_intermediacao = nullif(d ->> 'taxa_intermediacao', '')::numeric,
    multa_percentual = coalesce(nullif(d ->> 'multa_percentual', '')::numeric, 10),
    multa_forma = coalesce(nullif(d ->> 'multa_forma', ''), 'integral'),
    multa_base = coalesce(nullif(d ->> 'multa_base', ''), 'total'),
    multa_a_partir_dia = coalesce(nullif(d ->> 'multa_a_partir_dia', '')::int, 1),
    multa_pj_omitir = coalesce((d ->> 'multa_pj_omitir')::boolean, false),
    juros_percentual = coalesce(nullif(d ->> 'juros_percentual', '')::numeric, 0.033),
    juros_periodo = coalesce(nullif(d ->> 'juros_periodo', ''), 'dia'),
    juros_a_partir_dia = coalesce(nullif(d ->> 'juros_a_partir_dia', '')::int, 1),
    irrf_modo = coalesce(nullif(d ->> 'irrf_modo', ''), 'percentual'),
    garantia_tipo = coalesce(nullif(d ->> 'garantia_tipo', ''), 'nenhuma'),
    garantia_dados = coalesce(d -> 'garantia_dados', '{}'),
    supervisor_id = nullif(d ->> 'supervisor_id', '')::uuid,
    comissao_supervisor = coalesce(nullif(d ->> 'comissao_supervisor', '')::numeric, 0),
    clausula_pintura = coalesce((d ->> 'clausula_pintura')::boolean, false),
    clausula_meses = coalesce((d ->> 'clausula_meses')::boolean, false),
    unidade_id = nullif(d ->> 'unidade_id', '')::uuid,
    liberado_lancamentos = coalesce((d ->> 'liberado_lancamentos')::boolean, true),
    fora_do_lote = coalesce((d ->> 'fora_do_lote')::boolean, false),
    contrato_parcial = coalesce((d ->> 'contrato_parcial')::boolean, false),
    movimentacao_desde = case when v_ativo then c.movimentacao_desde else nullif(d ->> 'movimentacao_desde', '')::date end,
    movimentacao_proporcional = coalesce((d ->> 'movimentacao_proporcional')::boolean, false),
    ultimo_reajuste_em = case when v_ativo then c.ultimo_reajuste_em else nullif(d ->> 'ultimo_reajuste_em', '')::date end,
    valor_vigente = case when v_ativo then c.valor_vigente else nullif(d ->> 'valor_vigente', '')::numeric end,
    meses_para_reajuste = case when v_ativo then c.meses_para_reajuste else nullif(d ->> 'meses_para_reajuste', '')::int end,
    multa_rescisoria_alugueis = coalesce(nullif(d ->> 'multa_rescisoria_alugueis', '')::numeric, 3),
    observacoes = nullif(trim(d ->> 'observacoes'), ''),
    lead_id = coalesce(nullif(d ->> 'lead_id', '')::uuid, c.lead_id),
    atualizado_em = now()
  where c.id = v_id;

  -- Locatários e fiadores: a lista inteira, na ordem da tela.
  delete from public.contrato_partes cp where cp.contrato_id = v_id and cp.papel in ('locatario', 'fiador')
    and not ((cp.papel = 'locatario' and cp.pessoa_id = any (coalesce(p_locatarios, '{}'))) or (cp.papel = 'fiador' and cp.pessoa_id = any (coalesce(p_fiadores, '{}'))));
  insert into public.contrato_partes (contrato_id, pessoa_id, papel, ordem)
  select v_id, x, 'locatario', o from unnest(coalesce(p_locatarios, '{}')) with ordinality as t(x, o)
  on conflict (contrato_id, pessoa_id, papel) do update set ordem = excluded.ordem where contrato_partes.ordem <> excluded.ordem;
  insert into public.contrato_partes (contrato_id, pessoa_id, papel, ordem)
  select v_id, x, 'fiador', o from unnest(coalesce(p_fiadores, '{}')) with ordinality as t(x, o)
  on conflict (contrato_id, pessoa_id, papel) do update set ordem = excluded.ordem where contrato_partes.ordem <> excluded.ordem;
  -- Papel de cada pessoa no cadastro.
  update public.pessoas p set papeis = array_append(p.papeis, 'locatario'), atualizado_em = now()
  where p.id = any (coalesce(p_locatarios, '{}')) and not ('locatario' = any (p.papeis));
  update public.pessoas p set papeis = array_append(p.papeis, 'fiador'), atualizado_em = now()
  where p.id = any (coalesce(p_fiadores, '{}')) and not ('fiador' = any (p.papeis));
  return v_id;
end;
$$;
revoke all on function public.salvar_contrato(uuid, jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.salvar_contrato(uuid, jsonb, uuid[], uuid[]) to authenticated;

-- Ativar: confere tudo, numera, gera os períodos e guarda a cópia dos dados.
create or replace function public.ativar_contrato(p_id uuid)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  c public.contratos;
  v_falta text[] := '{}';
  v_soma numeric;
  v_numero bigint;
  v_snapshot jsonb;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  select * into c from public.contratos where id = p_id for update;
  if c.id is null then raise exception 'Contrato não encontrado'; end if;
  if c.situacao <> 'rascunho' then raise exception 'Só rascunho pode ser ativado'; end if;

  if c.imovel_codigo is null then v_falta := array_append(v_falta, 'imóvel'); end if;
  if not exists (select 1 from public.contrato_partes where contrato_id = p_id and papel = 'locatario') then v_falta := array_append(v_falta, 'locatário'); end if;
  if c.valor_inicial is null then v_falta := array_append(v_falta, 'valor inicial'); end if;
  if c.inicio is null then v_falta := array_append(v_falta, 'início do contrato'); end if;
  if c.prazo_meses is null then v_falta := array_append(v_falta, 'prazo'); end if;
  if c.reajuste_meses is null then v_falta := array_append(v_falta, 'meses de reajuste'); end if;
  if c.dia_inicio_periodo is null then v_falta := array_append(v_falta, 'dia do início do período'); end if;
  if c.dia_cobranca is null then v_falta := array_append(v_falta, 'dia da cobrança'); end if;
  if c.dia_repasse is null then v_falta := array_append(v_falta, 'dia do repasse'); end if;
  if c.taxa_administracao is null then v_falta := array_append(v_falta, 'taxa de administração'); end if;
  if c.garantia_tipo = 'fiador' and not exists (select 1 from public.contrato_partes where contrato_id = p_id and papel = 'fiador') then v_falta := array_append(v_falta, 'fiador'); end if;
  if c.indice = 'FIXO' and c.indice_fixo is null then v_falta := array_append(v_falta, 'percentual do reajuste fixo'); end if;
  if cardinality(v_falta) > 0 then
    raise exception 'Falta preencher: %', array_to_string(v_falta, ', ');
  end if;
  select coalesce(sum(percentual), 0) into v_soma from public.imovel_locadores where imovel_codigo = c.imovel_codigo;
  if v_soma <> 100 then
    raise exception 'O imóvel precisa de locadores somando 100%% em Imóveis administrados (hoje: %)', v_soma;
  end if;
  if exists (select 1 from public.contratos o where o.imovel_codigo = c.imovel_codigo and o.situacao = 'ativo') then
    raise exception 'Esse imóvel já tem um contrato ativo';
  end if;

  -- Locadores: cópia dos do imóvel, com o percentual de hoje.
  delete from public.contrato_partes where contrato_id = p_id and papel = 'locador';
  insert into public.contrato_partes (contrato_id, pessoa_id, papel, percentual, favorecido_id, ordem)
  select p_id, l.pessoa_id, 'locador', l.percentual, l.favorecido_id, row_number() over (order by l.percentual desc)
  from public.imovel_locadores l where l.imovel_codigo = c.imovel_codigo;

  -- Períodos.
  delete from public.contrato_periodos where contrato_id = p_id;
  insert into public.contrato_periodos (contrato_id, numero, inicio, fim, vencimento, repasse, valor, proporcional, reajuste, anterior_a_movimentacao)
  select p_id, x.* from interno.calcular_periodos(to_jsonb(c)) x;

  -- Cópia dos dados na assinatura.
  select jsonb_build_object(
    'contrato', to_jsonb(c) - 'snapshot',
    'imovel', (select to_jsonb(i) from public.imoveis i where i.codigo = c.imovel_codigo),
    'administracao', (select to_jsonb(a) from public.imoveis_locacao a where a.imovel_codigo = c.imovel_codigo),
    'partes', (select jsonb_agg(jsonb_build_object('papel', cp.papel, 'percentual', cp.percentual, 'pessoa', to_jsonb(p) - 'cadastro_completo') order by cp.papel, cp.ordem)
               from public.contrato_partes cp join public.pessoas p on p.id = cp.pessoa_id where cp.contrato_id = p_id)
  ) into v_snapshot;

  v_numero := nextval('public.locacao_contrato_numero');
  update public.contratos set
    situacao = 'ativo',
    numero = v_numero,
    valor_atual = coalesce(valor_vigente, valor_inicial),
    termino = (inicio + make_interval(months => prazo_meses))::date - 1,
    proximo_reajuste = case
      when meses_para_reajuste is not null and movimentacao_desde is not null then (movimentacao_desde + make_interval(months => meses_para_reajuste))::date
      when ultimo_reajuste_em is not null then (ultimo_reajuste_em + make_interval(months => reajuste_meses))::date
      else (inicio + make_interval(months => reajuste_meses))::date end,
    snapshot = v_snapshot,
    ativado_em = now(),
    ativado_por = interno.meu_corretor_id(),
    atualizado_em = now()
  where id = p_id;
  return v_numero;
end;
$$;
revoke all on function public.ativar_contrato(uuid) from public, anon;
grant execute on function public.ativar_contrato(uuid) to authenticated;

create or replace function public.excluir_rascunho_contrato(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  delete from public.contratos where id = p_id and situacao = 'rascunho';
  if not found then
    raise exception 'Só rascunho pode ser excluído';
  end if;
end;
$$;
revoke all on function public.excluir_rascunho_contrato(uuid) from public, anon;
grant execute on function public.excluir_rascunho_contrato(uuid) to authenticated;

-- Indicadores do painel da Locação (contratos ativos).
create or replace function public.locacao_indicadores()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $$
declare
  v_hoje date := (now() at time zone 'America/Campo_Grande')::date;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  return (
    select jsonb_build_object(
      'ativos', count(*) filter (where situacao = 'ativo'),
      'novos', count(*) filter (where situacao = 'ativo' and inicio >= v_hoje - 30),
      'reajuste', count(*) filter (where situacao = 'ativo' and proximo_reajuste <= (date_trunc('month', v_hoje) + interval '1 month - 1 day')::date),
      'vencendo', count(*) filter (where situacao = 'ativo' and termino between v_hoje and v_hoje + 15),
      'vencidos', count(*) filter (where situacao = 'ativo' and termino < v_hoje),
      'sem_garantia', count(*) filter (where situacao = 'ativo' and garantia_tipo = 'nenhuma'),
      'rascunhos', count(*) filter (where situacao = 'rascunho')
    )
    from public.contratos
  );
end;
$$;
revoke all on function public.locacao_indicadores() from public, anon;
grant execute on function public.locacao_indicadores() to authenticated;
