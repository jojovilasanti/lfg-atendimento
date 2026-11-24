-- Agenda de visitas aos imóveis de aluguel.
--
-- * Cada imóvel de aluguel tem um tipo de visita: acompanhada (com corretor) ou
--   sozinha (o cliente vai sem corretor). Muda: o corretor responsável pelo
--   imóvel (captador), o gestor e o administrativo.
-- * A grade de horários sai da configuração "agenda_visitas" (padrão: 1 hora,
--   segunda a sábado, 08:00 às 18:00, no fuso da empresa). Gestor e
--   administrativo mudam.
-- * Duas visitas no mesmo horário do mesmo imóvel: o banco recusa (restrição de
--   exclusão), mesmo que duas pessoas agendem no mesmo instante.
-- * Todos veem e agendam. Remarcar e cancelar: quem agendou, o gestor e o
--   administrativo. Tudo passa pelas funções abaixo; a tabela não aceita
--   escrita direta do painel.
-- * Agendada, remarcada ou cancelada: o banco chama a função "avisos", que manda
--   o alerta no WhatsApp do administrativo e dos gestores.

create extension if not exists btree_gist with schema extensions;

insert into public.configuracoes (chave, valor)
values ('agenda_visitas', '{"duracao_minutos": 60, "dias": [1, 2, 3, 4, 5, 6], "inicio": "08:00", "fim": "18:00"}'::jsonb)
on conflict (chave) do nothing;

-- Tipo de visita por imóvel. Fica fora de "imoveis" porque a sincronização do
-- Univen regrava aquela tabela. Sem linha aqui, vale "acompanhada".
create table if not exists public.imoveis_tipo_visita (
  imovel_codigo text primary key references public.imoveis (codigo) on delete cascade,
  tipo text not null check (tipo in ('acompanhada', 'sozinha')),
  atualizado_por uuid references public.corretores (id) on delete set null,
  atualizado_em timestamptz not null default now()
);
alter table public.imoveis_tipo_visita enable row level security;
create policy "Equipe vê o tipo de visita" on public.imoveis_tipo_visita for select to authenticated using (true);

create table if not exists public.visitas (
  id uuid primary key default gen_random_uuid(),
  imovel_codigo text not null references public.imoveis (codigo),
  inicio timestamptz not null,
  fim timestamptz not null,
  cliente_nome text not null check (length(trim(cliente_nome)) between 2 and 120),
  cliente_telefone text not null check (length(regexp_replace(cliente_telefone, '\D', '', 'g')) between 10 and 13),
  corretor_id uuid references public.corretores (id) on delete set null,
  tipo_visita text not null check (tipo_visita in ('acompanhada', 'sozinha')),
  observacoes text check (observacoes is null or length(observacoes) <= 1000),
  status text not null default 'agendada' check (status in ('agendada', 'cancelada')),
  agendada_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  remarcada_de timestamptz,
  cancelada_em timestamptz,
  cancelada_por uuid references public.corretores (id) on delete set null,
  motivo_cancelamento text,
  -- Resultado do último alerta: {evento, enviados, falhas, em}.
  aviso jsonb,
  check (fim > inicio),
  constraint visitas_sem_conflito exclude using gist (
    imovel_codigo with =,
    tstzrange(inicio, fim, '[)') with &&
  ) where (status = 'agendada')
);
create index if not exists visitas_inicio on public.visitas (inicio) where status = 'agendada';
alter table public.visitas enable row level security;
create policy "Equipe vê as visitas" on public.visitas for select to authenticated
  using (exists (select 1 from public.corretores c where c.usuario_id = (select auth.uid()) and c.ativo));

-- Configuração da agenda, com os padrões quando faltar algo.
create or replace function interno.agenda_visitas()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select '{"duracao_minutos": 60, "dias": [1, 2, 3, 4, 5, 6], "inicio": "08:00", "fim": "18:00"}'::jsonb
    || coalesce((select c.valor from public.configuracoes c where c.chave = 'agenda_visitas'), '{}'::jsonb);
$$;

create or replace function interno.tipo_visita(p_codigo text)
 returns text
 language sql
 stable security definer
 set search_path to ''
as $$
  select coalesce((select t.tipo from public.imoveis_tipo_visita t where t.imovel_codigo = p_codigo), 'acompanhada');
$$;

-- O horário cabe na grade? Dia da semana permitido, dentro do expediente e
-- começando num dos horários da grade (início + n × duração).
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
  return v_desde % v_minutos = 0 and extract(second from v_local) = 0;
end;
$$;

-- Grade de um dia para um imóvel: cada horário, livre ou reservado.
-- p_ignorar: a visita que está sendo remarcada (o horário dela conta como livre).
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
begin
  if not exists (select 1 from public.corretores c where c.usuario_id = (select auth.uid()) and c.ativo) then
    raise exception 'Sem acesso à agenda';
  end if;
  if not (v_cfg -> 'dias') @> to_jsonb(extract(isodow from p_dia)::integer) then
    return;
  end if;
  v_hora := v_abre;
  while v_hora + make_interval(mins => v_minutos) <= v_fecha and v_hora + make_interval(mins => v_minutos) > v_hora loop
    inicio := (p_dia + v_hora) at time zone interno.fuso();
    fim := inicio + make_interval(mins => v_minutos);
    select v.id into visita_id from public.visitas v
    where v.imovel_codigo = p_imovel and v.status = 'agendada'
      and (p_ignorar is null or v.id <> p_ignorar)
      and tstzrange(v.inicio, v.fim, '[)') && tstzrange(inicio, fim, '[)')
    limit 1;
    livre := visita_id is null;
    passado := inicio <= now();
    return next;
    v_hora := v_hora + make_interval(mins => v_minutos);
  end loop;
end;
$$;
revoke all on function public.horarios_de_visita(text, date, uuid) from public, anon;
grant execute on function public.horarios_de_visita(text, date, uuid) to authenticated;

-- Confere o que vale para agendar e remarcar.
create or replace function interno.conferir_horario_de_visita(p_imovel text, p_inicio timestamptz)
 returns void
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if not exists (select 1 from public.imoveis i where i.codigo = p_imovel and i.ativo and i.locacao) then
    raise exception 'A agenda é só para imóveis de aluguel ativos';
  end if;
  if p_inicio is null or p_inicio <= now() then
    raise exception 'Escolha um horário que ainda não passou';
  end if;
  if not interno.horario_na_grade(p_inicio) then
    raise exception 'Esse horário está fora da grade de visitas';
  end if;
end;
$$;

create or replace function public.agendar_visita(
  p_imovel text, p_inicio timestamptz, p_cliente_nome text, p_cliente_telefone text,
  p_corretor_id uuid default null, p_observacoes text default null
)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_id uuid;
begin
  if v_eu is null then
    raise exception 'Sem acesso à agenda';
  end if;
  perform interno.conferir_horario_de_visita(p_imovel, p_inicio);
  if p_corretor_id is not null and not exists (select 1 from public.corretores c where c.id = p_corretor_id and c.ativo) then
    raise exception 'Corretor responsável inválido';
  end if;
  begin
    insert into public.visitas (imovel_codigo, inicio, fim, cliente_nome, cliente_telefone, corretor_id, tipo_visita, observacoes, agendada_por)
    values (
      p_imovel, p_inicio,
      p_inicio + make_interval(mins => (interno.agenda_visitas() ->> 'duracao_minutos')::integer),
      trim(p_cliente_nome), trim(p_cliente_telefone), p_corretor_id,
      interno.tipo_visita(p_imovel), nullif(trim(p_observacoes), ''), v_eu
    )
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Esse horário acabou de ser reservado para este imóvel. Escolha outro.';
  end;
  return v_id;
end;
$$;
revoke all on function public.agendar_visita(text, timestamptz, text, text, uuid, text) from public, anon;
grant execute on function public.agendar_visita(text, timestamptz, text, text, uuid, text) to authenticated;

-- Quem pode mexer numa visita: quem agendou, o gestor e o administrativo.
create or replace function interno.posso_mexer_na_visita(p_visita public.visitas)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select interno.sou_gestor() or coalesce(p_visita.agendada_por = interno.meu_corretor_id(), false);
$$;

-- Editar: horário (remarcar, só para horários livres), dados do cliente,
-- corretor e observações.
create or replace function public.editar_visita(
  p_id uuid, p_inicio timestamptz, p_cliente_nome text, p_cliente_telefone text,
  p_corretor_id uuid default null, p_observacoes text default null
)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_visita public.visitas;
begin
  select * into v_visita from public.visitas where id = p_id for update;
  if v_visita.id is null then
    raise exception 'Visita não encontrada';
  end if;
  if not interno.posso_mexer_na_visita(v_visita) then
    raise exception 'Só quem agendou, o gestor ou o administrativo mudam esta visita';
  end if;
  if v_visita.status <> 'agendada' then
    raise exception 'Esta visita foi cancelada';
  end if;
  if p_inicio is distinct from v_visita.inicio then
    perform interno.conferir_horario_de_visita(v_visita.imovel_codigo, p_inicio);
  end if;
  if p_corretor_id is not null and p_corretor_id is distinct from v_visita.corretor_id
     and not exists (select 1 from public.corretores c where c.id = p_corretor_id and c.ativo) then
    raise exception 'Corretor responsável inválido';
  end if;
  begin
    update public.visitas set
      inicio = p_inicio,
      fim = p_inicio + (v_visita.fim - v_visita.inicio),
      remarcada_de = case when p_inicio is distinct from v_visita.inicio then v_visita.inicio else remarcada_de end,
      cliente_nome = trim(p_cliente_nome),
      cliente_telefone = trim(p_cliente_telefone),
      corretor_id = p_corretor_id,
      observacoes = nullif(trim(p_observacoes), ''),
      atualizado_em = now()
    where id = p_id;
  exception when exclusion_violation then
    raise exception 'Esse horário acabou de ser reservado para este imóvel. Escolha outro.';
  end;
end;
$$;
revoke all on function public.editar_visita(uuid, timestamptz, text, text, uuid, text) from public, anon;
grant execute on function public.editar_visita(uuid, timestamptz, text, text, uuid, text) to authenticated;

create or replace function public.cancelar_visita(p_id uuid, p_motivo text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_visita public.visitas;
begin
  select * into v_visita from public.visitas where id = p_id for update;
  if v_visita.id is null then
    raise exception 'Visita não encontrada';
  end if;
  if not interno.posso_mexer_na_visita(v_visita) then
    raise exception 'Só quem agendou, o gestor ou o administrativo cancelam esta visita';
  end if;
  if v_visita.status <> 'agendada' then
    raise exception 'Esta visita já foi cancelada';
  end if;
  update public.visitas set
    status = 'cancelada', cancelada_em = now(), cancelada_por = interno.meu_corretor_id(),
    motivo_cancelamento = nullif(trim(p_motivo), ''), atualizado_em = now()
  where id = p_id;
end;
$$;
revoke all on function public.cancelar_visita(uuid, text) from public, anon;
grant execute on function public.cancelar_visita(uuid, text) to authenticated;

-- Tipo de visita do imóvel: captador do imóvel, gestor ou administrativo.
create or replace function public.definir_tipo_visita(p_imovel text, p_tipo text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_captador text;
begin
  if p_tipo not in ('acompanhada', 'sozinha') then
    raise exception 'Tipo de visita inválido';
  end if;
  select i.captador into v_captador from public.imoveis i where i.codigo = p_imovel and i.locacao;
  if not found then
    raise exception 'O tipo de visita é só para imóveis de aluguel';
  end if;
  if not (interno.sou_gestor() or coalesce(interno.corretor_do_captador(v_captador) = interno.meu_corretor_id(), false)) then
    raise exception 'Só o corretor responsável pelo imóvel, o gestor ou o administrativo mudam o tipo de visita';
  end if;
  insert into public.imoveis_tipo_visita (imovel_codigo, tipo, atualizado_por)
  values (p_imovel, p_tipo, interno.meu_corretor_id())
  on conflict (imovel_codigo) do update set tipo = excluded.tipo, atualizado_por = excluded.atualizado_por, atualizado_em = now();
end;
$$;
revoke all on function public.definir_tipo_visita(text, text) from public, anon;
grant execute on function public.definir_tipo_visita(text, text) to authenticated;

-- Grade da agenda: gestor e administrativo.
create or replace function public.salvar_agenda_visitas(p_duracao integer, p_dias integer[], p_inicio text, p_fim text)
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
  if coalesce(p_inicio, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_fim, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Informe o início e o fim no formato HH:MM';
  end if;
  if p_inicio::time + make_interval(mins => p_duracao) > p_fim::time then
    raise exception 'O expediente precisa caber pelo menos uma visita';
  end if;
  v_valor := jsonb_build_object('duracao_minutos', p_duracao, 'dias', (select jsonb_agg(distinct d order by d) from unnest(p_dias) d), 'inicio', p_inicio, 'fim', p_fim);
  insert into public.configuracoes (chave, valor) values ('agenda_visitas', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  return v_valor;
end;
$$;
revoke all on function public.salvar_agenda_visitas(integer, integer[], text, text) from public, anon;
grant execute on function public.salvar_agenda_visitas(integer, integer[], text, text) to authenticated;

-- Alerta no WhatsApp: agendada, remarcada (mudou o horário) ou cancelada.
create or replace function interno.avisar_visita()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_evento text;
begin
  if tg_op = 'INSERT' then
    v_evento := 'agendada';
  elsif new.status = 'cancelada' and old.status = 'agendada' then
    v_evento := 'cancelada';
  elsif new.status = 'agendada' and new.inicio is distinct from old.inicio then
    v_evento := 'remarcada';
  else
    return new;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('visita_id', new.id, 'evento', v_evento),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
  return new;
end;
$$;

drop trigger if exists visitas_avisar on public.visitas;
create trigger visitas_avisar
  after insert or update of status, inicio on public.visitas
  for each row execute function interno.avisar_visita();
