-- Agenda para a equipe toda e horários da tarde:
--   * Todos veem a agenda da equipe (corretor, imóvel, horário e status). Nome,
--     telefone, lead e observações do cliente só para quem pode mexer na visita
--     (corretor da visita, quem marcou, gestor e administrativo), que também são
--     os únicos que editam e cancelam. A leitura passa pela função
--     agenda_da_equipe; a tabela continua fechada para os outros.
--   * A grade (aluguel e, agora, venda) vai da primeira visita ao último início
--     (padrão 15h), de 1 em 1 hora. O horário ocupado mostra quem marcou.
--   * Visita de venda passa a usar a grade e a duração da configuração, como o aluguel.

-- Configuração: "ultimo_inicio" no lugar de "fim" (a última visita terminava às).
create or replace function interno.agenda_visitas()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select '{"duracao_minutos": 60, "dias": [1, 2, 3, 4, 5, 6], "inicio": "08:00", "ultimo_inicio": "15:00"}'::jsonb
    || coalesce((select c.valor from public.configuracoes c where c.chave = 'agenda_visitas'), '{}'::jsonb);
$$;

update public.configuracoes
set valor = (valor - 'fim') || jsonb_build_object('ultimo_inicio', '15:00')
where chave = 'agenda_visitas';

drop function if exists public.salvar_agenda_visitas(integer, integer[], text, text);
create or replace function public.salvar_agenda_visitas(p_duracao integer, p_dias integer[], p_inicio text, p_ultimo_inicio text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_valor jsonb;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo mudam a agenda de visitas';
  end if;
  if p_duracao is null or p_duracao not between 15 and 240 then
    raise exception 'A duração da visita vai de 15 a 240 minutos';
  end if;
  if p_dias is null or cardinality(p_dias) = 0 or exists (select 1 from unnest(p_dias) d where d not between 1 and 7) then
    raise exception 'Escolha pelo menos um dia da semana';
  end if;
  if coalesce(p_inicio, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_ultimo_inicio, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Informe a primeira visita e o último início no formato HH:MM';
  end if;
  if p_ultimo_inicio::time < p_inicio::time then
    raise exception 'O último início precisa ser depois da primeira visita';
  end if;
  v_valor := jsonb_build_object('duracao_minutos', p_duracao, 'dias', (select jsonb_agg(distinct d order by d) from unnest(p_dias) d),
    'inicio', p_inicio, 'ultimo_inicio', p_ultimo_inicio);
  insert into public.configuracoes (chave, valor) values ('agenda_visitas', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  return v_valor;
end;
$$;
revoke all on function public.salvar_agenda_visitas(integer, integer[], text, text) from public, anon;
grant execute on function public.salvar_agenda_visitas(integer, integer[], text, text) to authenticated;

-- Grade de um imóvel num dia: de hora em hora, da primeira visita ao último início.
drop function if exists public.horarios_de_visita(text, date, uuid);
create or replace function public.horarios_de_visita(p_imovel text, p_dia date, p_ignorar uuid default null)
 returns table (inicio timestamptz, fim timestamptz, livre boolean, passado boolean, visita_id uuid, quem text)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
#variable_conflict use_variable
declare
  v_cfg jsonb := interno.agenda_visitas();
  v_minutos integer := (v_cfg ->> 'duracao_minutos')::integer;
  v_abre time := (v_cfg ->> 'inicio')::time;
  v_ultimo time := (v_cfg ->> 'ultimo_inicio')::time;
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
  while v_hora <= v_ultimo loop
    inicio := (p_dia + v_hora) at time zone interno.fuso();
    fim := inicio + make_interval(mins => v_minutos);
    select v.* into v_achada from public.visitas v
    where v.imovel_codigo = p_imovel and interno.visita_ativa(v.status)
      and (p_ignorar is null or v.id <> p_ignorar)
      and tstzrange(v.inicio, v.fim, '[)') && tstzrange(inicio, fim, '[)')
    order by v.inicio
    limit 1;
    livre := v_achada.id is null;
    visita_id := case when v_achada.id is not null and interno.posso_mexer_na_visita(v_achada) then v_achada.id end;
    -- Primeiro nome de quem marcou (ou do corretor da visita).
    quem := case when v_achada.id is not null then
      (select split_part(c.nome, ' ', 1) from public.corretores c where c.id = coalesce(v_achada.agendada_por, v_achada.corretor_id)) end;
    passado := inicio <= now();
    return next;
    v_achada := null;
    exit when v_hora + interval '1 hour' <= v_hora; -- virou a meia-noite
    v_hora := v_hora + interval '1 hour';
  end loop;
end;
$$;
revoke all on function public.horarios_de_visita(text, date, uuid) from public, anon;
grant execute on function public.horarios_de_visita(text, date, uuid) to authenticated;

create or replace function interno.horario_na_grade(p_inicio timestamptz)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_cfg jsonb := interno.agenda_visitas();
  v_local timestamp := p_inicio at time zone interno.fuso();
  v_abre time := (v_cfg ->> 'inicio')::time;
  v_ultimo time := (v_cfg ->> 'ultimo_inicio')::time;
  v_desde integer;
begin
  if not (v_cfg -> 'dias') @> to_jsonb(extract(isodow from v_local)::integer) then
    return false;
  end if;
  if v_local::time < v_abre or v_local::time > v_ultimo then
    return false;
  end if;
  v_desde := (extract(epoch from (v_local::time - v_abre)) / 60)::integer;
  return v_desde % 60 = 0 and extract(second from v_local) = 0;
end;
$$;

-- Venda também na grade.
create or replace function interno.conferir_compromisso(p_tipo text, p_imovel text, p_inicio timestamptz, p_ignorar_grade boolean default false)
 returns void
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if p_tipo not in ('aluguel', 'venda', 'captacao', 'outro') then
    raise exception 'Tipo de compromisso inválido';
  end if;
  if p_inicio is null or p_inicio <= now() then
    raise exception 'Escolha um horário que ainda não passou';
  end if;
  if p_tipo = 'aluguel' then
    if not exists (select 1 from public.imoveis i where i.codigo = p_imovel and i.ativo and i.locacao) then
      raise exception 'Visita de aluguel: escolha um imóvel de aluguel ativo';
    end if;
  elsif p_tipo = 'venda' then
    if not exists (select 1 from public.imoveis i where i.codigo = p_imovel and i.ativo and i.venda) then
      raise exception 'Visita de venda: escolha um imóvel à venda ativo';
    end if;
  elsif p_imovel is not null and not exists (select 1 from public.imoveis i where i.codigo = p_imovel) then
    raise exception 'Imóvel não encontrado';
  end if;
  if p_tipo in ('aluguel', 'venda') and not p_ignorar_grade and not interno.horario_na_grade(p_inicio) then
    raise exception 'Esse horário está fora da grade de visitas';
  end if;
end;
$$;

-- Duração da configuração também na venda.
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
  if p_tipo in ('aluguel', 'venda') then
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

-- Agenda da equipe: todos veem; dados do cliente só para quem pode mexer.
create or replace function public.agenda_da_equipe(
  p_desde timestamptz default null, p_ate timestamptz default null, p_corretor uuid default null,
  p_id uuid default null, p_imovel text default null
)
 returns setof jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if interno.meu_corretor_id() is null then
    raise exception 'Sem acesso à agenda';
  end if;
  return query
    select jsonb_build_object(
      'id', v.id, 'tipo', v.tipo, 'imovel_codigo', v.imovel_codigo, 'local', v.local,
      'inicio', v.inicio, 'fim', v.fim, 'corretor_id', v.corretor_id, 'agendada_por', v.agendada_por,
      'tipo_visita', v.tipo_visita, 'status', v.status, 'remarcada_de', v.remarcada_de, 'retorno', v.retorno,
      'pode_mexer', pm.pode,
      'lead_id', case when pm.pode then v.lead_id end,
      'cliente_nome', case when pm.pode then v.cliente_nome end,
      'cliente_telefone', case when pm.pode then v.cliente_telefone end,
      'observacoes', case when pm.pode then v.observacoes end,
      'motivo_cancelamento', case when pm.pode then v.motivo_cancelamento end,
      'retorno_obs', case when pm.pode then v.retorno_obs end,
      'imoveis', case when i.codigo is not null then jsonb_build_object(
        'referencia', i.referencia, 'titulo', i.titulo, 'tipo', i.tipo, 'bairro', i.bairro, 'endereco', i.endereco,
        'numero', i.numero, 'cidade', i.cidade, 'latitude', i.latitude, 'longitude', i.longitude) end,
      'corretor', case when c.id is not null then jsonb_build_object('nome', c.nome) end,
      'quem', case when q.id is not null then jsonb_build_object('nome', q.nome) end
    )
    from public.visitas v
    cross join lateral (select interno.posso_mexer_na_visita(v) as pode) pm
    left join public.imoveis i on i.codigo = v.imovel_codigo
    left join public.corretores c on c.id = v.corretor_id
    left join public.corretores q on q.id = v.agendada_por
    where (p_id is null or v.id = p_id)
      and (p_imovel is null or v.imovel_codigo = p_imovel)
      and (p_desde is null or v.inicio >= p_desde)
      and (p_ate is null or v.inicio < p_ate)
      and (p_corretor is null or v.corretor_id = p_corretor)
    order by case when p_imovel is not null then v.inicio end desc, v.inicio
    limit 1000;
end;
$$;
revoke all on function public.agenda_da_equipe(timestamptz, timestamptz, uuid, uuid, text) from public, anon;
grant execute on function public.agenda_da_equipe(timestamptz, timestamptz, uuid, uuid, text) to authenticated;
