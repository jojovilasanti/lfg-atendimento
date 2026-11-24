-- Agenda de visitas:
--   * A grade do aluguel oferece horários de 1 em 1 hora (antes andava de acordo
--     com a duração: com 2 h de duração, só 8h, 10h e 12h). Cada visita continua
--     ocupando a duração configurada; o horário que bate com outra visita do
--     mesmo imóvel aparece como reservado.
--   * Quem agenda diz se a visita é acompanhada pelo corretor ou se o cliente vai
--     sozinho. Sem escolha, vale o padrão do imóvel.

create or replace function public.horarios_de_visita(p_imovel text, p_dia date, p_ignorar uuid default null)
 returns table (inicio timestamptz, fim timestamptz, livre boolean, passado boolean, visita_id uuid)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
#variable_conflict use_variable
declare
  v_cfg jsonb := interno.agenda_visitas();
  v_minutos integer := (v_cfg ->> 'duracao_minutos')::integer;
  v_abre time := (v_cfg ->> 'inicio')::time;
  v_fecha time := (v_cfg ->> 'fim')::time;
  v_hora time;
  v_achada public.visitas;
begin
  if interno.meu_corretor_id() is null then
    raise exception 'Sem acesso à agenda';
  end if;
  if not (v_cfg -> 'dias') @> to_jsonb(extract(isodow from p_dia)::integer) then
    return;
  end if;
  v_hora := v_abre;
  while v_hora + make_interval(mins => v_minutos) <= v_fecha and v_hora + make_interval(mins => v_minutos) > v_hora loop
    inicio := (p_dia + v_hora) at time zone interno.fuso();
    fim := inicio + make_interval(mins => v_minutos);
    select v.* into v_achada from public.visitas v
    where v.imovel_codigo = p_imovel and interno.visita_ativa(v.status)
      and (p_ignorar is null or v.id <> p_ignorar)
      and tstzrange(v.inicio, v.fim, '[)') && tstzrange(inicio, fim, '[)')
    limit 1;
    livre := v_achada.id is null;
    visita_id := case when v_achada.id is not null and interno.posso_mexer_na_visita(v_achada) then v_achada.id end;
    passado := inicio <= now();
    return next;
    v_achada := null;
    exit when v_hora + interval '1 hour' <= v_hora; -- virou a meia-noite
    v_hora := v_hora + interval '1 hour';
  end loop;
end;
$$;

create or replace function interno.horario_na_grade(p_inicio timestamptz)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_cfg jsonb := interno.agenda_visitas();
  v_local timestamp := p_inicio at time zone interno.fuso();
  v_minutos integer := (v_cfg ->> 'duracao_minutos')::integer;
  v_abre time := (v_cfg ->> 'inicio')::time;
  v_fecha time := (v_cfg ->> 'fim')::time;
  v_desde integer;
begin
  if not (v_cfg -> 'dias') @> to_jsonb(extract(isodow from v_local)::integer) then
    return false;
  end if;
  if v_local::time < v_abre or v_local::time + make_interval(mins => v_minutos) > v_fecha
     or v_local::time + make_interval(mins => v_minutos) < v_local::time then
    return false;
  end if;
  v_desde := (extract(epoch from (v_local::time - v_abre)) / 60)::integer;
  return v_desde % 60 = 0 and extract(second from v_local) = 0;
end;
$$;

-- Acompanhada ou sozinha: escolhida ao agendar e ao editar.
create or replace function interno.conferir_tipo_visita(p_tipo_visita text)
 returns void language plpgsql immutable set search_path to ''
as $$
begin
  if p_tipo_visita is not null and p_tipo_visita not in ('acompanhada', 'sozinha') then
    raise exception 'Escolha se a visita é acompanhada ou sozinha';
  end if;
end;
$$;

drop function if exists public.agendar_visita(text, timestamptz, text, uuid, text, text, text, uuid, text, integer);
create or replace function public.agendar_visita(
  p_tipo text, p_inicio timestamptz, p_imovel text default null, p_lead_id uuid default null,
  p_cliente_nome text default null, p_cliente_telefone text default null, p_local text default null,
  p_corretor_id uuid default null, p_observacoes text default null, p_duracao integer default null,
  p_tipo_visita text default null
)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_corretor uuid := interno.corretor_do_compromisso(p_corretor_id);
  v_duracao integer := coalesce(p_duracao, (interno.agenda_visitas() ->> 'duracao_minutos')::integer);
  v_cliente record;
  v_id uuid;
begin
  perform interno.conferir_tipo_visita(p_tipo_visita);
  if p_tipo = 'aluguel' then
    v_duracao := (interno.agenda_visitas() ->> 'duracao_minutos')::integer;
  end if;
  if v_duracao not between 15 and 480 then
    raise exception 'A duração vai de 15 minutos a 8 horas';
  end if;
  perform interno.conferir_compromisso(p_tipo, nullif(p_imovel, ''), p_inicio);
  select * into v_cliente from interno.dados_do_cliente(p_lead_id, p_cliente_nome, p_cliente_telefone);
  begin
    insert into public.visitas (tipo, imovel_codigo, lead_id, local, inicio, fim, cliente_nome, cliente_telefone,
      corretor_id, tipo_visita, observacoes, agendada_por, status_em)
    values (
      p_tipo, nullif(p_imovel, ''), p_lead_id, nullif(trim(p_local), ''), p_inicio,
      p_inicio + make_interval(mins => v_duracao),
      v_cliente.nome, v_cliente.telefone, v_corretor,
      coalesce(p_tipo_visita, case when nullif(p_imovel, '') is not null then interno.tipo_visita(p_imovel) else 'acompanhada' end),
      nullif(trim(p_observacoes), ''), v_eu, now()
    )
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Esse horário já está reservado para este imóvel. Escolha outro.';
  when check_violation then
    raise exception 'Faltam dados: visita precisa de imóvel, nome e telefone do cliente; captação e outro, de um imóvel ou um local.';
  end;
  return v_id;
end;
$$;
revoke all on function public.agendar_visita(text, timestamptz, text, uuid, text, text, text, uuid, text, integer, text) from public, anon;
grant execute on function public.agendar_visita(text, timestamptz, text, uuid, text, text, text, uuid, text, integer, text) to authenticated;

drop function if exists public.editar_visita(uuid, timestamptz, text, uuid, text, text, text, uuid, text, text);
create or replace function public.editar_visita(
  p_id uuid, p_inicio timestamptz, p_imovel text default null, p_lead_id uuid default null,
  p_cliente_nome text default null, p_cliente_telefone text default null, p_local text default null,
  p_corretor_id uuid default null, p_observacoes text default null, p_tipo text default null,
  p_tipo_visita text default null
)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_visita public.visitas;
  v_tipo text;
  v_corretor uuid;
  v_cliente record;
  v_mudou_hora boolean;
begin
  perform interno.conferir_tipo_visita(p_tipo_visita);
  select * into v_visita from public.visitas where id = p_id for update;
  if v_visita.id is null or not interno.posso_mexer_na_visita(v_visita) then
    raise exception 'Visita não encontrada';
  end if;
  if not interno.visita_ativa(v_visita.status) then
    raise exception 'Só dá para editar visitas agendadas ou confirmadas';
  end if;
  v_tipo := coalesce(p_tipo, v_visita.tipo);
  v_corretor := interno.corretor_do_compromisso(coalesce(p_corretor_id, case when not interno.sou_gestor() then v_visita.corretor_id end));
  v_mudou_hora := p_inicio is distinct from v_visita.inicio;
  if v_mudou_hora or v_tipo <> v_visita.tipo or nullif(p_imovel, '') is distinct from v_visita.imovel_codigo then
    perform interno.conferir_compromisso(v_tipo, nullif(p_imovel, ''), p_inicio);
  end if;
  select * into v_cliente from interno.dados_do_cliente(p_lead_id, p_cliente_nome, p_cliente_telefone);
  begin
    update public.visitas set
      tipo = v_tipo,
      imovel_codigo = nullif(p_imovel, ''),
      lead_id = p_lead_id,
      local = nullif(trim(p_local), ''),
      inicio = p_inicio,
      fim = p_inicio + (v_visita.fim - v_visita.inicio),
      remarcada_de = case when v_mudou_hora then v_visita.inicio else remarcada_de end,
      -- Remarcou: volta a ser agendada e os lembretes valem de novo.
      status = case when v_mudou_hora then 'agendada' else status end,
      lembrete_dia_em = case when v_mudou_hora then null else lembrete_dia_em end,
      lembrete_hora_em = case when v_mudou_hora then null else lembrete_hora_em end,
      cliente_nome = v_cliente.nome,
      cliente_telefone = v_cliente.telefone,
      corretor_id = v_corretor,
      tipo_visita = coalesce(p_tipo_visita, tipo_visita),
      observacoes = nullif(trim(p_observacoes), ''),
      atualizado_em = now()
    where id = p_id;
  exception when exclusion_violation then
    raise exception 'Esse horário já está reservado para este imóvel. Escolha outro.';
  when check_violation then
    raise exception 'Faltam dados: visita precisa de imóvel, nome e telefone do cliente; captação e outro, de um imóvel ou um local.';
  end;
end;
$$;
revoke all on function public.editar_visita(uuid, timestamptz, text, uuid, text, text, text, uuid, text, text, text) from public, anon;
grant execute on function public.editar_visita(uuid, timestamptz, text, uuid, text, text, text, uuid, text, text, text) to authenticated;
