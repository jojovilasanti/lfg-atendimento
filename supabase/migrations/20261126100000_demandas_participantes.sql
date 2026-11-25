-- Participantes das demandas (pedido do gestor, 26/11/2026).
--
-- * Além do responsável, a demanda pode ter participantes. Só o gestor inclui
--   e tira participantes (como só ele passa demanda para outra pessoa).
-- * Participante muda o status, como o responsável. Editar e excluir continua
--   com quem criou e com o gestor.
-- * Quem entra na demanda (participante novo, ou responsável de uma demanda que
--   outra pessoa criou) recebe notificação no celular pela função avisos.
-- * A demanda entra no Google Agenda do responsável e de cada participante que
--   conectou a conta (função google-agenda; a chamada sai pelo gatilho que já
--   existe em demandas, depois que a transação termina).

create table if not exists public.demanda_participantes (
  demanda_id uuid not null references public.demandas (id) on delete cascade,
  corretor_id uuid not null references public.corretores (id) on delete cascade,
  adicionado_por uuid references public.corretores (id) on delete set null,
  adicionado_em timestamptz not null default now(),
  primary key (demanda_id, corretor_id)
);
create index if not exists demanda_participantes_corretor on public.demanda_participantes (corretor_id);
alter table public.demanda_participantes enable row level security;

-- Mesma regra das demandas: a equipe vê todas. Escrita só pelas funções abaixo.
drop policy if exists "Equipe vê os participantes das demandas" on public.demanda_participantes;
create policy "Equipe vê os participantes das demandas" on public.demanda_participantes for select to authenticated
  using ((select interno.meu_corretor_id()) is not null);

-- Pede à função avisos a notificação de quem acabou de entrar na demanda.
create or replace function interno.avisar_demanda(p_demanda_id uuid, p_pessoas uuid[])
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if p_pessoas is null or cardinality(p_pessoas) = 0 then
    return;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('demanda_id', p_demanda_id, 'pessoas', to_jsonb(p_pessoas)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
end;
$$;
revoke all on function interno.avisar_demanda(uuid, uuid[]) from public, anon, authenticated;

-- salvar_demanda ganha p_participantes (null = não mexe nos participantes).
drop function if exists public.salvar_demanda(uuid, text, text, uuid, timestamptz, text);
create or replace function public.salvar_demanda(
  p_id uuid, p_titulo text, p_descricao text, p_responsavel_id uuid, p_prazo timestamptz, p_status text default 'pendente',
  p_participantes uuid[] default null
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
  v_participantes uuid[];
  v_antes uuid[] := '{}';
  v_avisar uuid[] := '{}';
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

  -- Participantes: só o gestor mexe. Sem repetir o responsável nem gente inativa.
  if p_participantes is not null then
    if not v_pleno then
      raise exception 'Só o gestor adiciona participantes';
    end if;
    select coalesce(array_agg(distinct c.id), '{}') into v_participantes
    from public.corretores c
    where c.id = any (p_participantes) and c.ativo and c.id <> p_responsavel_id;
    if cardinality(v_participantes) <> (select count(distinct x) from unnest(p_participantes) x where x <> p_responsavel_id) then
      raise exception 'Participante inválido';
    end if;
  end if;

  if p_id is null then
    insert into public.demandas (titulo, descricao, responsavel_id, prazo, status, concluida_em, criada_por)
    values (trim(p_titulo), nullif(trim(p_descricao), ''), p_responsavel_id, p_prazo, p_status,
            case when p_status = 'concluida' then now() end, v_eu)
    returning id into v_id;
    if p_responsavel_id <> v_eu then
      v_avisar := array[p_responsavel_id];
    end if;
  else
    select * into v_atual from public.demandas where id = p_id for update;
    if v_atual.id is null then
      raise exception 'Demanda não encontrada';
    end if;
    if not (v_pleno or coalesce(v_atual.criada_por = v_eu, false)) then
      raise exception 'Só quem criou a demanda ou o gestor editam';
    end if;
    v_id := p_id;
    select coalesce(array_agg(corretor_id), '{}') into v_antes from public.demanda_participantes where demanda_id = v_id;
    update public.demandas set
      titulo = trim(p_titulo),
      descricao = nullif(trim(p_descricao), ''),
      responsavel_id = p_responsavel_id,
      prazo = p_prazo,
      status = p_status,
      concluida_em = case when p_status = 'concluida' then coalesce(concluida_em, now()) end,
      atualizado_em = now()
    where id = v_id;
    if p_responsavel_id <> v_atual.responsavel_id and p_responsavel_id <> v_eu and not (p_responsavel_id = any (v_antes)) then
      v_avisar := array[p_responsavel_id];
    end if;
    -- Quem virou responsável sai da lista de participantes.
    delete from public.demanda_participantes where demanda_id = v_id and corretor_id = p_responsavel_id;
  end if;

  if v_participantes is not null then
    delete from public.demanda_participantes where demanda_id = v_id and not (corretor_id = any (v_participantes));
    insert into public.demanda_participantes (demanda_id, corretor_id, adicionado_por)
    select v_id, x, v_eu from unnest(v_participantes) x
    on conflict do nothing;
    v_avisar := v_avisar || coalesce(
      (select array_agg(x) from unnest(v_participantes) x where not (x = any (v_antes)) and x <> v_eu), '{}');
  end if;

  perform interno.avisar_demanda(v_id, v_avisar);
  return v_id;
end;
$$;
revoke all on function public.salvar_demanda(uuid, text, text, uuid, timestamptz, text, uuid[]) from public, anon;
grant execute on function public.salvar_demanda(uuid, text, text, uuid, timestamptz, text, uuid[]) to authenticated;

-- Mudar só o status: o responsável, os participantes, quem criou e o gestor.
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
  if not (
    interno.sou_gestor_pleno()
    or coalesce(v_atual.responsavel_id = v_eu, false)
    or coalesce(v_atual.criada_por = v_eu, false)
    or exists (select 1 from public.demanda_participantes p where p.demanda_id = p_id and p.corretor_id = v_eu)
  ) then
    raise exception 'Só o responsável, os participantes, quem criou ou o gestor mudam o status';
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
