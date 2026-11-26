-- Módulo de Locação, Etapa 1: base (plano em documentos/locacao/fase-0-plano.md).
--
-- * interno.acessa_locacao(): quem usa o módulo. Hoje é igual a sou_gestor()
--   (gestor ou administrativo). Todas as tabelas e funções da Locação usam só
--   ela; o corretor não vê nada do módulo, nem chamando o banco direto.
-- * locacao_auditoria: quem mudou o quê e quando no módulo. Só leitura para a
--   gestão; a escrita vem dos gatilhos e das funções.
-- * locacao_unidades: unidade que captou o contrato (começa com "Matriz").
-- * Parâmetros padrão dos contratos em configuracoes ('locacao_padroes'),
--   alterados por salvar_locacao_padroes() (com auditoria).

create or replace function interno.acessa_locacao()
 returns boolean
 language sql
 stable
 security definer
 set search_path to ''
as $$
  select interno.sou_gestor();
$$;
revoke all on function interno.acessa_locacao() from public, anon;
grant execute on function interno.acessa_locacao() to authenticated;

-- Auditoria -------------------------------------------------------------------
create table if not exists public.locacao_auditoria (
  id bigint generated always as identity primary key,
  tabela text not null,
  registro_id text,
  acao text not null check (acao in ('criar', 'alterar', 'excluir')),
  antes jsonb,
  depois jsonb,
  corretor_id uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists locacao_auditoria_registro on public.locacao_auditoria (tabela, registro_id, criado_em desc);
alter table public.locacao_auditoria enable row level security;
revoke all on public.locacao_auditoria from anon;
drop policy if exists "Gestão vê a auditoria da locação" on public.locacao_auditoria;
create policy "Gestão vê a auditoria da locação" on public.locacao_auditoria for select to authenticated
  using ((select interno.acessa_locacao()));

-- Gatilho genérico: grava cada criação, alteração e exclusão das tabelas do módulo.
create or replace function interno.auditar_locacao()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_antes jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_depois jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and v_antes = v_depois then
    return new;
  end if;
  insert into public.locacao_auditoria (tabela, registro_id, acao, antes, depois, corretor_id)
  values (
    tg_table_name,
    coalesce(v_depois ->> 'id', v_antes ->> 'id', v_depois ->> 'chave', v_antes ->> 'chave'),
    case tg_op when 'INSERT' then 'criar' when 'UPDATE' then 'alterar' else 'excluir' end,
    v_antes, v_depois, interno.meu_corretor_id()
  );
  return coalesce(new, old);
end;
$$;
revoke all on function interno.auditar_locacao() from public, anon, authenticated;

-- Unidades de captação ---------------------------------------------------------
create table if not exists public.locacao_unidades (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 2 and 80),
  ativa boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists locacao_unidades_nome on public.locacao_unidades (lower(trim(nome)));
alter table public.locacao_unidades enable row level security;
revoke all on public.locacao_unidades from anon;
drop policy if exists "Gestão vê as unidades" on public.locacao_unidades;
create policy "Gestão vê as unidades" on public.locacao_unidades for select to authenticated
  using ((select interno.acessa_locacao()));
drop trigger if exists locacao_unidades_auditoria on public.locacao_unidades;
create trigger locacao_unidades_auditoria after insert or update or delete on public.locacao_unidades
  for each row execute function interno.auditar_locacao();

insert into public.locacao_unidades (nome)
select 'Matriz' where not exists (select 1 from public.locacao_unidades);

create or replace function public.salvar_locacao_unidade(p_id uuid, p_nome text, p_ativa boolean default true)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_id uuid;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if length(trim(coalesce(p_nome, ''))) < 2 then
    raise exception 'Informe o nome da unidade';
  end if;
  if exists (select 1 from public.locacao_unidades u where lower(trim(u.nome)) = lower(trim(p_nome)) and u.id is distinct from p_id) then
    raise exception 'Já existe uma unidade com esse nome';
  end if;
  if p_id is null then
    insert into public.locacao_unidades (nome, ativa) values (trim(p_nome), coalesce(p_ativa, true)) returning id into v_id;
  else
    update public.locacao_unidades set nome = trim(p_nome), ativa = coalesce(p_ativa, true), atualizado_em = now()
    where id = p_id returning id into v_id;
    if v_id is null then
      raise exception 'Unidade não encontrada';
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.salvar_locacao_unidade(uuid, text, boolean) from public, anon;
grant execute on function public.salvar_locacao_unidade(uuid, text, boolean) to authenticated;

-- Parâmetros padrão dos contratos ---------------------------------------------
-- Valores da tela de referência; a gestão confirma e ajusta na tela Locação.
insert into public.configuracoes (chave, valor, descricao)
values (
  'locacao_padroes',
  jsonb_build_object(
    'prazo_meses', 36,
    'reajuste_meses', 12,
    'indice', 'IGP-M',
    'dia_cobranca', 2,
    'cobranca_referencia', 'apos_periodo',
    'dia_repasse', 5,
    'repasse_referencia', 'apos_periodo',
    'taxa_administracao', 10,
    'taxa_base', 'percentual_aluguel',
    'taxa_intermediacao', 100,
    'multa_percentual', 10,
    'multa_forma', 'integral',
    'multa_base', 'total',
    'multa_a_partir_dia', 1,
    'juros_percentual', 0.033,
    'juros_periodo', 'dia',
    'juros_a_partir_dia', 1,
    'multa_rescisoria_alugueis', 3,
    'desconto_pontualidade', 0,
    'confirmado', false
  ),
  'Valores padrão de um contrato de locação novo (tela Locação → Parâmetros).'
)
on conflict (chave) do nothing;

drop trigger if exists configuracoes_locacao_auditoria on public.configuracoes;
create trigger configuracoes_locacao_auditoria after update on public.configuracoes
  for each row when (new.chave = 'locacao_padroes') execute function interno.auditar_locacao();

create or replace function public.salvar_locacao_padroes(p_valor jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_numeros text[] := array['prazo_meses', 'reajuste_meses', 'dia_cobranca', 'dia_repasse', 'taxa_administracao', 'taxa_intermediacao',
    'multa_percentual', 'multa_a_partir_dia', 'juros_percentual', 'juros_a_partir_dia', 'multa_rescisoria_alugueis', 'desconto_pontualidade'];
  v_campo text;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if jsonb_typeof(p_valor) <> 'object' then
    raise exception 'Parâmetros inválidos';
  end if;
  foreach v_campo in array v_numeros loop
    if jsonb_typeof(p_valor -> v_campo) <> 'number' or (p_valor ->> v_campo)::numeric < 0 then
      raise exception 'Valor inválido em %', v_campo;
    end if;
  end loop;
  if (p_valor ->> 'dia_cobranca')::int not between 1 and 31 or (p_valor ->> 'dia_repasse')::int not between 1 and 31 then
    raise exception 'O dia de cobrança e o de repasse vão de 1 a 31';
  end if;
  if (p_valor ->> 'prazo_meses')::int < 1 or (p_valor ->> 'reajuste_meses')::int < 1 then
    raise exception 'Prazo e reajuste precisam de pelo menos 1 mês';
  end if;
  if coalesce(p_valor ->> 'indice', '') not in ('IGP-M', 'IPCA', 'INPC', 'IVAR', 'IGP-DI', 'FIXO')
    or coalesce(p_valor ->> 'cobranca_referencia', '') not in ('apos_periodo', 'no_periodo')
    or coalesce(p_valor ->> 'repasse_referencia', '') not in ('apos_periodo', 'no_periodo')
    or coalesce(p_valor ->> 'taxa_base', '') not in ('percentual_aluguel', 'valor_fixo', 'percentual_cobranca')
    or coalesce(p_valor ->> 'multa_forma', '') not in ('integral', 'diaria_30')
    or coalesce(p_valor ->> 'multa_base', '') not in ('total', 'aluguel')
    or coalesce(p_valor ->> 'juros_periodo', '') not in ('dia', 'mes') then
    raise exception 'Opção inválida nos parâmetros';
  end if;
  update public.configuracoes
  set valor = p_valor || jsonb_build_object('confirmado', true), atualizado_em = now()
  where chave = 'locacao_padroes';
end;
$$;
revoke all on function public.salvar_locacao_padroes(jsonb) from public, anon;
grant execute on function public.salvar_locacao_padroes(jsonb) to authenticated;
