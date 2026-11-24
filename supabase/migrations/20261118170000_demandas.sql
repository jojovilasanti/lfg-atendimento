-- Agenda de demandas (tarefas da equipe), separada dos "próximos passos" do
-- funil (tabela tarefas, ligada a um lead).
--
-- * O gestor cria demandas para qualquer pessoa; o administrativo e o corretor,
--   só para si mesmos.
-- * Cada um vê as demandas em que é responsável ou que criou. O gestor vê todas.
--   O administrativo, por enquanto, só as próprias (decisão pendente do gestor).
-- * O responsável muda o status (pendente, em andamento, concluída).
--   Quem criou edita e exclui; o gestor edita e exclui todas.
-- Tudo passa pelas funções abaixo; a tabela não aceita escrita direta do painel.

create table if not exists public.demandas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (length(trim(titulo)) between 2 and 160),
  descricao text check (descricao is null or length(descricao) <= 4000),
  responsavel_id uuid not null references public.corretores (id) on delete cascade,
  prazo timestamptz not null,
  status text not null default 'pendente' check (status in ('pendente', 'em_andamento', 'concluida')),
  concluida_em timestamptz,
  criada_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists demandas_responsavel_prazo on public.demandas (responsavel_id, prazo);
create index if not exists demandas_prazo on public.demandas (prazo);
alter table public.demandas enable row level security;

create policy "Vê as próprias demandas; o gestor vê todas" on public.demandas for select to authenticated
  using (
    (select interno.sou_gestor_pleno())
    or responsavel_id = (select interno.meu_corretor_id())
    or criada_por = (select interno.meu_corretor_id())
  );

create or replace function public.salvar_demanda(
  p_id uuid, p_titulo text, p_descricao text, p_responsavel_id uuid, p_prazo timestamptz, p_status text default 'pendente'
)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_pleno boolean := interno.sou_gestor_pleno();
  v_atual public.demandas;
  v_id uuid;
begin
  if v_eu is null then
    raise exception 'Sem acesso às demandas';
  end if;
  if coalesce(p_status, '') not in ('pendente', 'em_andamento', 'concluida') then
    raise exception 'Status inválido';
  end if;
  if p_prazo is null then
    raise exception 'Informe a data e a hora do prazo';
  end if;
  if not exists (select 1 from public.corretores c where c.id = p_responsavel_id and c.ativo) then
    raise exception 'Responsável inválido';
  end if;
  if not v_pleno and p_responsavel_id <> v_eu then
    raise exception 'Só o gestor cria demandas para outras pessoas';
  end if;

  if p_id is null then
    insert into public.demandas (titulo, descricao, responsavel_id, prazo, status, concluida_em, criada_por)
    values (trim(p_titulo), nullif(trim(p_descricao), ''), p_responsavel_id, p_prazo, p_status,
            case when p_status = 'concluida' then now() end, v_eu)
    returning id into v_id;
    return v_id;
  end if;

  select * into v_atual from public.demandas where id = p_id for update;
  if v_atual.id is null then
    raise exception 'Demanda não encontrada';
  end if;
  if not (v_pleno or coalesce(v_atual.criada_por = v_eu, false)) then
    raise exception 'Só quem criou a demanda ou o gestor editam';
  end if;
  update public.demandas set
    titulo = trim(p_titulo),
    descricao = nullif(trim(p_descricao), ''),
    responsavel_id = p_responsavel_id,
    prazo = p_prazo,
    status = p_status,
    concluida_em = case when p_status = 'concluida' then coalesce(concluida_em, now()) end,
    atualizado_em = now()
  where id = p_id;
  return p_id;
end;
$$;
revoke all on function public.salvar_demanda(uuid, text, text, uuid, timestamptz, text) from public, anon;
grant execute on function public.salvar_demanda(uuid, text, text, uuid, timestamptz, text) to authenticated;

-- Mudar só o status: o responsável, quem criou e o gestor.
create or replace function public.mudar_status_demanda(p_id uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_atual public.demandas;
begin
  if coalesce(p_status, '') not in ('pendente', 'em_andamento', 'concluida') then
    raise exception 'Status inválido';
  end if;
  select * into v_atual from public.demandas where id = p_id for update;
  if v_atual.id is null then
    raise exception 'Demanda não encontrada';
  end if;
  if not (interno.sou_gestor_pleno() or coalesce(v_atual.responsavel_id = v_eu, false) or coalesce(v_atual.criada_por = v_eu, false)) then
    raise exception 'Só o responsável, quem criou ou o gestor mudam o status';
  end if;
  update public.demandas set
    status = p_status,
    concluida_em = case when p_status = 'concluida' then coalesce(concluida_em, now()) end,
    atualizado_em = now()
  where id = p_id;
end;
$$;
revoke all on function public.mudar_status_demanda(uuid, text) from public, anon;
grant execute on function public.mudar_status_demanda(uuid, text) to authenticated;

create or replace function public.excluir_demanda(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_atual public.demandas;
begin
  select * into v_atual from public.demandas where id = p_id for update;
  if v_atual.id is null then
    raise exception 'Demanda não encontrada';
  end if;
  if not (interno.sou_gestor_pleno() or coalesce(v_atual.criada_por = interno.meu_corretor_id(), false)) then
    raise exception 'Só quem criou a demanda ou o gestor excluem';
  end if;
  delete from public.demandas where id = p_id;
end;
$$;
revoke all on function public.excluir_demanda(uuid) from public, anon;
grant execute on function public.excluir_demanda(uuid) to authenticated;
