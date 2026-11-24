-- Agenda do corretor: a agenda de visitas de aluguel vira a agenda de todos os
-- compromissos com cliente.
--   * Tipos: visita de aluguel, visita de venda, captação e outro. Aluguel
--     continua na grade de horários (chave no escritório); os outros têm
--     horário livre. Captação e outro podem não ter imóvel do estoque (local).
--   * Status: agendada, confirmada, realizada, cancelada, não compareceu.
--   * Retorno depois da visita: gostou, não gostou, quer proposta, quer ver outros.
--   * Lead ligado à visita: cada mudança fica no histórico da conversa.
--   * Permissões: o corretor vê e mexe só nas próprias (corretor da visita ou
--     quem agendou); gestor e administrativo veem e mexem em todas.
--   * O mesmo imóvel continua sem duas visitas no mesmo horário (o banco recusa).
--     O mesmo corretor com dois compromissos no mesmo horário só gera aviso.
--   * Lembretes ao corretor 1 dia e 1 hora antes: função "lembretes", chamada a
--     cada 5 minutos.

alter table public.visitas
  add column if not exists tipo text not null default 'aluguel',
  add column if not exists lead_id uuid references public.leads (id) on delete set null,
  add column if not exists local text,
  add column if not exists retorno text,
  add column if not exists retorno_obs text,
  add column if not exists retorno_em timestamptz,
  add column if not exists status_em timestamptz,
  add column if not exists lembrete_dia_em timestamptz,
  add column if not exists lembrete_hora_em timestamptz;

alter table public.visitas alter column imovel_codigo drop not null;
alter table public.visitas alter column cliente_nome drop not null;
alter table public.visitas alter column cliente_telefone drop not null;
alter table public.visitas alter column tipo_visita set default 'acompanhada';

alter table public.visitas drop constraint if exists visitas_status_check;
alter table public.visitas add constraint visitas_status_check
  check (status in ('agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu'));
alter table public.visitas drop constraint if exists visitas_tipo_check;
alter table public.visitas add constraint visitas_tipo_check
  check (tipo in ('aluguel', 'venda', 'captacao', 'outro'));
alter table public.visitas drop constraint if exists visitas_retorno_check;
alter table public.visitas add constraint visitas_retorno_check
  check (retorno is null or retorno in ('gostou', 'nao_gostou', 'quer_proposta', 'quer_ver_outros'));
alter table public.visitas drop constraint if exists visitas_retorno_obs_check;
alter table public.visitas add constraint visitas_retorno_obs_check
  check (retorno_obs is null or length(retorno_obs) <= 1000);
alter table public.visitas drop constraint if exists visitas_local_check;
alter table public.visitas add constraint visitas_local_check
  check (local is null or length(local) <= 300);
-- Visita (aluguel ou venda) tem imóvel e cliente; captação e outro precisam de
-- pelo menos um imóvel ou um local.
alter table public.visitas drop constraint if exists visitas_dados_do_tipo;
alter table public.visitas add constraint visitas_dados_do_tipo check (
  case when tipo in ('aluguel', 'venda')
    then imovel_codigo is not null and cliente_nome is not null and cliente_telefone is not null
    else imovel_codigo is not null or local is not null
  end
);

alter table public.visitas drop constraint if exists visitas_sem_conflito;
alter table public.visitas add constraint visitas_sem_conflito exclude using gist (
  imovel_codigo with =,
  tstzrange(inicio, fim, '[)') with &&
) where (status in ('agendada', 'confirmada') and imovel_codigo is not null);

drop index if exists public.visitas_inicio;
create index if not exists visitas_inicio on public.visitas (inicio);
create index if not exists visitas_corretor_inicio on public.visitas (corretor_id, inicio);
create index if not exists visitas_lead on public.visitas (lead_id) where lead_id is not null;

-- Visita ativa: ainda vai acontecer (ou está acontecendo).
create or replace function interno.visita_ativa(p_status text)
 returns boolean language sql immutable set search_path to ''
as $$ select p_status in ('agendada', 'confirmada'); $$;

-- Quem vê e quem mexe: gestão vê tudo; o corretor, o que é dele.
create or replace function interno.posso_mexer_na_visita(p_visita public.visitas)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select interno.sou_gestor()
    or coalesce(p_visita.corretor_id = interno.meu_corretor_id(), false)
    or coalesce(p_visita.agendada_por = interno.meu_corretor_id(), false);
$$;

drop policy if exists "Equipe vê as visitas" on public.visitas;
drop policy if exists "Cada um vê a sua agenda" on public.visitas;
create policy "Cada um vê a sua agenda" on public.visitas for select to authenticated
  using (interno.sou_gestor() or corretor_id = interno.meu_corretor_id() or agendada_por = interno.meu_corretor_id());

-- Grade do imóvel de aluguel: horário reservado aparece como reservado, sem
-- mostrar de quem é (o corretor não vê a agenda dos outros).
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
    v_hora := v_hora + make_interval(mins => v_minutos);
  end loop;
end;
$$;

-- Confere tipo, imóvel e horário de um compromisso.
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
    if not p_ignorar_grade and not interno.horario_na_grade(p_inicio) then
      raise exception 'Esse horário está fora da grade de visitas de aluguel';
    end if;
  elsif p_tipo = 'venda' then
    if not exists (select 1 from public.imoveis i where i.codigo = p_imovel and i.ativo and i.venda) then
      raise exception 'Visita de venda: escolha um imóvel à venda ativo';
    end if;
  elsif p_imovel is not null and not exists (select 1 from public.imoveis i where i.codigo = p_imovel) then
    raise exception 'Imóvel não encontrado';
  end if;
end;
$$;

-- Corretor da visita: o corretor só agenda para si; a gestão escolhe.
create or replace function interno.corretor_do_compromisso(p_corretor_id uuid)
 returns uuid
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
begin
  if v_eu is null then
    raise exception 'Sem acesso à agenda';
  end if;
  if not interno.sou_gestor() then
    if p_corretor_id is not null and p_corretor_id <> v_eu then
      raise exception 'Você agenda só na sua agenda';
    end if;
    return v_eu;
  end if;
  if p_corretor_id is not null and not exists (select 1 from public.corretores c where c.id = p_corretor_id and c.ativo) then
    raise exception 'Corretor responsável inválido';
  end if;
  return p_corretor_id;
end;
$$;

-- Compromissos do corretor que batem com o horário (para o aviso na tela).
create or replace function public.conflitos_na_agenda(p_corretor_id uuid, p_inicio timestamptz, p_fim timestamptz, p_ignorar uuid default null)
 returns table (id uuid, inicio timestamptz, fim timestamptz, tipo text, titulo text)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if interno.meu_corretor_id() is null then
    raise exception 'Sem acesso à agenda';
  end if;
  if p_corretor_id is null then
    return;
  end if;
  if not interno.sou_gestor() and p_corretor_id <> interno.meu_corretor_id() then
    raise exception 'Você vê só a sua agenda';
  end if;
  return query
    select v.id, v.inicio, v.fim, v.tipo,
      coalesce(i.referencia || coalesce(' · ' || i.bairro, ''), v.local, 'Compromisso') || coalesce(' · ' || v.cliente_nome, '')
    from public.visitas v left join public.imoveis i on i.codigo = v.imovel_codigo
    where v.corretor_id = p_corretor_id and interno.visita_ativa(v.status)
      and (p_ignorar is null or v.id <> p_ignorar)
      and tstzrange(v.inicio, v.fim, '[)') && tstzrange(p_inicio, p_fim, '[)')
    order by v.inicio;
end;
$$;
revoke all on function public.conflitos_na_agenda(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.conflitos_na_agenda(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- Cliente: do lead (se escolhido) ou digitado.
create or replace function interno.dados_do_cliente(p_lead_id uuid, p_nome text, p_telefone text)
 returns table (nome text, telefone text)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_lead public.leads;
begin
  if p_lead_id is not null then
    select * into v_lead from public.leads l where l.id = p_lead_id and l.excluido_em is null;
    if v_lead.id is null or not interno.posso_ver_lead(p_lead_id) then
      raise exception 'Lead não encontrado';
    end if;
  end if;
  nome := coalesce(nullif(trim(p_nome), ''), v_lead.nome);
  telefone := coalesce(nullif(regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'), ''),
    case when v_lead.whatsapp ~ '^\d+$' then v_lead.whatsapp end);
  return next;
end;
$$;

drop function if exists public.agendar_visita(text, timestamptz, text, text, uuid, text);
create or replace function public.agendar_visita(
  p_tipo text, p_inicio timestamptz, p_imovel text default null, p_lead_id uuid default null,
  p_cliente_nome text default null, p_cliente_telefone text default null, p_local text default null,
  p_corretor_id uuid default null, p_observacoes text default null, p_duracao integer default null
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
      case when nullif(p_imovel, '') is not null then interno.tipo_visita(p_imovel) else 'acompanhada' end,
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
revoke all on function public.agendar_visita(text, timestamptz, text, uuid, text, text, text, uuid, text, integer) from public, anon;
grant execute on function public.agendar_visita(text, timestamptz, text, uuid, text, text, text, uuid, text, integer) to authenticated;

drop function if exists public.editar_visita(uuid, timestamptz, text, text, uuid, text);
create or replace function public.editar_visita(
  p_id uuid, p_inicio timestamptz, p_imovel text default null, p_lead_id uuid default null,
  p_cliente_nome text default null, p_cliente_telefone text default null, p_local text default null,
  p_corretor_id uuid default null, p_observacoes text default null, p_tipo text default null
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
revoke all on function public.editar_visita(uuid, timestamptz, text, uuid, text, text, text, uuid, text, text) from public, anon;
grant execute on function public.editar_visita(uuid, timestamptz, text, uuid, text, text, text, uuid, text, text) to authenticated;

-- Status: confirmada, realizada, cancelada, não compareceu (ou de volta a agendada).
create or replace function public.mudar_status_visita(p_id uuid, p_status text, p_motivo text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_visita public.visitas;
begin
  select * into v_visita from public.visitas where id = p_id for update;
  if v_visita.id is null or not interno.posso_mexer_na_visita(v_visita) then
    raise exception 'Visita não encontrada';
  end if;
  if p_status not in ('agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu') then
    raise exception 'Status inválido';
  end if;
  if p_status = v_visita.status then
    return;
  end if;
  if p_status in ('realizada', 'nao_compareceu') and v_visita.inicio > now() then
    raise exception 'Marque como realizada ou não compareceu depois do horário da visita';
  end if;
  if interno.visita_ativa(p_status) and not interno.visita_ativa(v_visita.status) and v_visita.inicio <= now() then
    raise exception 'Essa visita já passou. Agende uma nova.';
  end if;
  begin
    update public.visitas set
      status = p_status, status_em = now(), atualizado_em = now(),
      cancelada_em = case when p_status = 'cancelada' then now() else null end,
      cancelada_por = case when p_status = 'cancelada' then interno.meu_corretor_id() else null end,
      motivo_cancelamento = case when p_status = 'cancelada' then nullif(trim(p_motivo), '') else null end
    where id = p_id;
  exception when exclusion_violation then
    raise exception 'Esse horário foi reservado para este imóvel depois do cancelamento. Agende um novo.';
  end;
end;
$$;
revoke all on function public.mudar_status_visita(uuid, text, text) from public, anon;
grant execute on function public.mudar_status_visita(uuid, text, text) to authenticated;

create or replace function public.cancelar_visita(p_id uuid, p_motivo text default null)
 returns void language sql security definer set search_path to ''
as $$ select public.mudar_status_visita(p_id, 'cancelada', p_motivo); $$;

-- Retorno do cliente depois da visita.
create or replace function public.registrar_retorno_visita(p_id uuid, p_retorno text, p_obs text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_visita public.visitas;
begin
  select * into v_visita from public.visitas where id = p_id for update;
  if v_visita.id is null or not interno.posso_mexer_na_visita(v_visita) then
    raise exception 'Visita não encontrada';
  end if;
  if p_retorno is not null and p_retorno not in ('gostou', 'nao_gostou', 'quer_proposta', 'quer_ver_outros') then
    raise exception 'Retorno inválido';
  end if;
  if v_visita.inicio > now() then
    raise exception 'O retorno é registrado depois da visita';
  end if;
  update public.visitas set
    retorno = p_retorno, retorno_obs = nullif(trim(p_obs), ''), retorno_em = now(), atualizado_em = now(),
    status = case when status in ('agendada', 'confirmada') then 'realizada' else status end,
    status_em = case when status in ('agendada', 'confirmada') then now() else status_em end
  where id = p_id;
end;
$$;
revoke all on function public.registrar_retorno_visita(uuid, text, text) from public, anon;
grant execute on function public.registrar_retorno_visita(uuid, text, text) to authenticated;

-- Histórico do lead: cada visita agendada, remarcada, com status ou retorno
-- novo vira uma linha do sistema na conversa.
create or replace function interno.historico_da_visita()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_quando text := to_char(new.inicio at time zone interno.fuso(), 'DD/MM "às" HH24:MI');
  v_onde text;
  v_quem text := (select c.nome from public.corretores c where c.id = interno.meu_corretor_id());
  v_texto text;
  v_rotulo text := case new.tipo when 'aluguel' then 'Visita (aluguel)' when 'venda' then 'Visita (venda)' when 'captacao' then 'Captação' else 'Compromisso' end;
begin
  if new.lead_id is null then
    return new;
  end if;
  select coalesce(i.referencia || coalesce(' · ' || i.bairro, ''), new.local, '') into v_onde
  from (select 1) x left join public.imoveis i on i.codigo = new.imovel_codigo;
  if tg_op = 'INSERT' then
    v_texto := format('%s agendada para %s%s', v_rotulo, v_quando, case when v_onde <> '' then ' · ' || v_onde else '' end);
  elsif new.lead_id is distinct from old.lead_id then
    v_texto := format('%s de %s ligada a este lead%s', v_rotulo, v_quando, case when v_onde <> '' then ' · ' || v_onde else '' end);
  elsif new.inicio is distinct from old.inicio then
    v_texto := format('%s remarcada para %s (era %s)', v_rotulo, v_quando, to_char(old.inicio at time zone interno.fuso(), 'DD/MM "às" HH24:MI'));
  elsif new.status is distinct from old.status then
    v_texto := format('%s de %s: %s%s', v_rotulo, v_quando,
      case new.status when 'agendada' then 'agendada de novo' when 'confirmada' then 'confirmada' when 'realizada' then 'realizada'
        when 'cancelada' then 'cancelada' else 'o cliente não compareceu' end,
      case when new.status = 'cancelada' and new.motivo_cancelamento is not null then ' (' || new.motivo_cancelamento || ')' else '' end);
  end if;
  -- O retorno pode vir junto com a mudança para "realizada": vira outra linha.
  if tg_op = 'UPDATE' and new.retorno is distinct from old.retorno and new.retorno is not null then
    v_texto := concat_ws(E'\n', v_texto, format('Retorno da visita de %s: %s%s', v_quando,
      case new.retorno when 'gostou' then 'gostou' when 'nao_gostou' then 'não gostou' when 'quer_proposta' then 'quer fazer proposta' else 'quer ver outros imóveis' end,
      case when new.retorno_obs is not null then ' · ' || new.retorno_obs else '' end));
  end if;
  if v_texto is null then
    return new;
  end if;
  insert into public.mensagens (lead_id, autor, conteudo)
  values (new.lead_id, 'sistema', v_texto || case when v_quem is not null then format(' (por %s)', split_part(v_quem, ' ', 1)) else '' end);
  return new;
end;
$$;
drop trigger if exists visitas_historico on public.visitas;
create trigger visitas_historico
  after insert or update of inicio, status, retorno, lead_id on public.visitas
  for each row execute function interno.historico_da_visita();

-- Alerta no WhatsApp do administrativo e dos gestores: continua só para as
-- visitas de aluguel (chave no escritório), como antes.
create or replace function interno.avisar_visita()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_evento text;
begin
  if new.tipo <> 'aluguel' or new.imovel_codigo is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_evento := 'agendada';
  elsif new.status = 'cancelada' and interno.visita_ativa(old.status) then
    v_evento := 'cancelada';
  elsif interno.visita_ativa(new.status) and new.inicio is distinct from old.inicio then
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

-- Lembretes: 1 dia antes (se a visita foi marcada com pelo menos 20 horas de
-- antecedência) e 1 hora antes (se marcada com pelo menos 70 minutos). A função
-- "lembretes" manda a notificação e marca o envio.
create or replace function interno.chamar_lembretes()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not exists (
    select 1 from public.visitas v
    where interno.visita_ativa(v.status) and v.corretor_id is not null and v.inicio > now()
      and ((v.lembrete_dia_em is null and v.inicio <= now() + interval '24 hours' and v.inicio > now() + interval '3 hours'
            and v.criado_em <= v.inicio - interval '20 hours')
        or (v.lembrete_hora_em is null and v.inicio <= now() + interval '60 minutes'
            and v.criado_em <= v.inicio - interval '70 minutes'))
  ) then
    return;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/lembretes',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 20000
  );
end;
$$;

select cron.unschedule('lembretes-visitas') where exists (select 1 from cron.job where jobname = 'lembretes-visitas');
select cron.schedule('lembretes-visitas', '*/5 * * * *', 'select interno.chamar_lembretes()');
