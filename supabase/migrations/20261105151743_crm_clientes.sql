-- CRM de clientes, primeira parte. O lead continua sendo o cliente: o mesmo
-- registro que a Thais atende entra no funil quando um corretor fica com ele.
-- Traz as etapas da negociação, o histórico, os próximos passos com lembrete,
-- o cadastro de cliente que não veio pelo WhatsApp e os imóveis compatíveis.

create type public.lead_etapa as enum ('a_contatar', 'em_contato', 'visita', 'proposta', 'fechado', 'perdido');

alter table public.leads
  add column etapa public.lead_etapa,
  add column etapa_desde timestamptz,
  add column motivo_perda text,
  add column valor_negocio numeric(14, 2),
  add column email text;
comment on column public.leads.etapa is 'Etapa da negociação. Nula enquanto o lead não está com um corretor.';
comment on column public.leads.valor_negocio is 'Valor do negócio fechado, informado pelo corretor.';
create index leads_etapa_idx on public.leads (etapa) where etapa is not null;

update public.leads l
set etapa = case
      when exists (select 1 from public.mensagens m where m.lead_id = l.id and m.autor = 'corretor') then 'em_contato'::public.lead_etapa
      else 'a_contatar'::public.lead_etapa
    end,
    etapa_desde = coalesce(l.status_desde, now())
where l.status = 'com_corretor';

insert into public.configuracoes (chave, valor, descricao) values
  ('motivos_perda',
   '["Preço acima do orçamento", "Escolheu outro imóvel ou imobiliária", "Não aprovou financiamento ou seguro fiança", "Desistiu ou adiou a mudança", "Parou de responder", "Contato inválido", "Outro"]',
   'Motivos que o corretor escolhe ao marcar uma negociação como perdida.');

-- Histórico do que aconteceu com o cliente. Fica fora das mensagens: não vai
-- para o WhatsApp nem para a IA.
create table public.atividades (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  corretor_id uuid references public.corretores (id) on delete set null,
  tipo text not null check (tipo in ('nota', 'ligacao', 'visita', 'proposta', 'etapa', 'tarefa', 'imovel_enviado')),
  conteudo text,
  dados jsonb not null default '{}',
  criado_em timestamptz not null default now()
);
create index atividades_lead_idx on public.atividades (lead_id, id desc);
create index atividades_corretor_idx on public.atividades (corretor_id);

create table public.tarefas (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  corretor_id uuid not null references public.corretores (id) on delete cascade,
  titulo text not null check (char_length(titulo) between 1 and 200),
  vence_em timestamptz not null,
  concluida_em timestamptz,
  avisada_em timestamptz,
  criada_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now()
);
comment on column public.tarefas.avisada_em is 'Quando saiu o lembrete do vencimento. Remarcar a tarefa libera outro lembrete.';
create index tarefas_corretor_idx on public.tarefas (corretor_id, vence_em);
create index tarefas_lead_idx on public.tarefas (lead_id);
create index tarefas_criada_por_idx on public.tarefas (criada_por);

alter table public.atividades enable row level security;
alter table public.tarefas enable row level security;
create policy "Equipe vê o histórico dos leads permitidos" on public.atividades
  for select to authenticated using (interno.posso_ver_lead(lead_id));
create policy "Equipe vê as tarefas dos leads permitidos" on public.tarefas
  for select to authenticated using (interno.posso_ver_lead(lead_id));

alter publication supabase_realtime add table public.atividades, public.tarefas;

-- Regras automáticas ----------------------------------------------------------

create function interno.acompanhar_etapa() returns trigger
language plpgsql set search_path = ''
as $$
begin
  -- Lead com corretor entra no funil, ou volta para ele se estava encerrado.
  if new.status = 'com_corretor' and (new.etapa is null or new.etapa in ('fechado', 'perdido')) then
    new.etapa := 'a_contatar';
    new.motivo_perda := null;
    new.valor_negocio := null;
  end if;
  if tg_op = 'INSERT' or new.etapa is distinct from old.etapa then
    new.etapa_desde := case when new.etapa is not null then now() end;
  end if;
  return new;
end;
$$;

create trigger leads_acompanhar_etapa
before insert or update on public.leads
for each row execute function interno.acompanhar_etapa();

create function interno.registrar_mudanca_de_etapa() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.atividades (lead_id, corretor_id, tipo, dados)
  values (
    new.id, interno.meu_corretor_id(), 'etapa',
    jsonb_strip_nulls(jsonb_build_object('de', old.etapa, 'para', new.etapa, 'motivo', new.motivo_perda, 'valor', new.valor_negocio))
  );
  return null;
end;
$$;

-- Sem "update of etapa": a mudança feita pelo gatilho acima não contaria.
create trigger leads_registrar_etapa
after update on public.leads
for each row when (old.etapa is distinct from new.etapa and new.etapa is not null)
execute function interno.registrar_mudanca_de_etapa();

-- As tarefas abertas acompanham o lead quando ele muda de corretor.
create function interno.passar_tarefas_junto() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.tarefas set corretor_id = new.corretor_id
  where lead_id = new.id and concluida_em is null;
  return null;
end;
$$;

create trigger leads_passar_tarefas
after update of corretor_id on public.leads
for each row when (new.corretor_id is not null and new.corretor_id is distinct from old.corretor_id)
execute function interno.passar_tarefas_junto();

-- Primeira mensagem do corretor: saiu de "A contatar".
create function interno.avancar_etapa_ao_responder() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.leads set etapa = 'em_contato' where id = new.lead_id and etapa = 'a_contatar';
  return null;
end;
$$;

create trigger mensagens_avancar_etapa
after insert on public.mensagens
for each row when (new.autor = 'corretor')
execute function interno.avancar_etapa_ao_responder();

-- Cliente encerrado voltou a escrever: a negociação reabre com o mesmo corretor.
-- Sem corretor ativo, volta para a Thais, que passa de novo quando for a hora.
create function interno.reabrir_ao_escrever() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
begin
  select * into v_lead from public.leads where id = new.lead_id and status = 'encerrado' for update;
  if not found then
    return null;
  end if;
  if exists (select 1 from public.corretores c where c.id = v_lead.corretor_id and c.ativo) then
    update public.leads set status = 'com_corretor', etapa = 'a_contatar', motivo_perda = null, valor_negocio = null
    where id = v_lead.id;
    insert into public.mensagens (lead_id, autor, conteudo)
    values (v_lead.id, 'sistema', 'O cliente voltou a escrever e a negociação foi reaberta');
  else
    update public.leads
    set status = 'em_atendimento_ia', etapa = null, corretor_id = null, ia_ativa = true, motivo_perda = null, valor_negocio = null
    where id = v_lead.id;
    insert into public.mensagens (lead_id, autor, conteudo)
    values (v_lead.id, 'sistema', 'O cliente voltou a escrever e a assistente retomou o atendimento');
  end if;
  return null;
end;
$$;

create trigger mensagens_reabrir_encerrado
after insert on public.mensagens
for each row when (new.autor = 'cliente')
execute function interno.reabrir_ao_escrever();

-- Lembrete da tarefa vencida: mesmo caminho dos outros avisos (função "avisos").
create function interno.avisar_tarefas_vencidas() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_tarefa record;
  v_total integer := 0;
begin
  for v_tarefa in
    update public.tarefas t
    set avisada_em = now()
    from public.leads l
    where l.id = t.lead_id
      and l.corretor_id = t.corretor_id
      and t.concluida_em is null
      and t.avisada_em is null
      and t.vence_em <= now()
    returning t.id, t.corretor_id
  loop
    continue when not exists (select 1 from public.push_inscricoes p where p.corretor_id = v_tarefa.corretor_id);
    perform net.http_post(
      url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
      body := jsonb_build_object('tarefa_id', v_tarefa.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
      ),
      timeout_milliseconds := 15000
    );
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$;

select cron.schedule('avisar-tarefas', '* * * * *', $$select interno.avisar_tarefas_vencidas()$$);

-- Ações do painel -------------------------------------------------------------

create function interno.posso_editar_lead(p_lead_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select interno.sou_gestor() or exists (
    select 1 from public.leads l where l.id = p_lead_id and l.corretor_id = interno.meu_corretor_id()
  );
$$;

create function public.mudar_etapa(p_lead_id uuid, p_etapa public.lead_etapa, p_motivo text default null, p_valor numeric default null)
returns public.leads
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_motivo text := nullif(trim(p_motivo), '');
begin
  if not interno.posso_editar_lead(p_lead_id) then
    raise exception 'Só o corretor do lead ou o gestor podem mudar a etapa';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.corretor_id is null then
    raise exception 'Este lead ainda não está com um corretor';
  end if;
  if p_etapa = 'perdido' and v_motivo is null then
    raise exception 'Escolha o motivo da perda';
  end if;
  if p_valor is not null and p_valor < 0 then
    raise exception 'O valor do negócio não pode ser negativo';
  end if;

  if p_etapa in ('fechado', 'perdido') then
    update public.tarefas set concluida_em = now() where lead_id = p_lead_id and concluida_em is null;
    update public.leads
    set etapa = p_etapa, status = 'encerrado', ia_ativa = false,
        motivo_perda = case when p_etapa = 'perdido' then v_motivo end,
        valor_negocio = case when p_etapa = 'fechado' then p_valor end
    where id = p_lead_id
    returning * into v_lead;
  else
    update public.leads
    set etapa = p_etapa, status = 'com_corretor', motivo_perda = null, valor_negocio = null
    where id = p_lead_id
    returning * into v_lead;
  end if;
  return v_lead;
end;
$$;

create function public.registrar_atividade(p_lead_id uuid, p_tipo text, p_conteudo text, p_dados jsonb default '{}')
returns public.atividades
language plpgsql security definer set search_path = ''
as $$
declare
  v_atividade public.atividades;
begin
  if not interno.posso_editar_lead(p_lead_id) then
    raise exception 'Só o corretor do lead ou o gestor podem registrar no histórico';
  end if;
  if p_tipo not in ('nota', 'ligacao', 'visita', 'proposta', 'imovel_enviado') then
    raise exception 'Tipo de registro inválido';
  end if;
  if nullif(trim(p_conteudo), '') is null then
    raise exception 'Escreva o que aconteceu';
  end if;
  insert into public.atividades (lead_id, corretor_id, tipo, conteudo, dados)
  values (p_lead_id, interno.meu_corretor_id(), p_tipo, trim(p_conteudo), coalesce(p_dados, '{}'))
  returning * into v_atividade;
  return v_atividade;
end;
$$;

create function public.criar_tarefa(p_lead_id uuid, p_titulo text, p_vence_em timestamptz)
returns public.tarefas
language plpgsql security definer set search_path = ''
as $$
declare
  v_tarefa public.tarefas;
  v_eu uuid := interno.meu_corretor_id();
begin
  if not interno.posso_editar_lead(p_lead_id) then
    raise exception 'Só o corretor do lead ou o gestor podem criar tarefas';
  end if;
  if nullif(trim(p_titulo), '') is null or p_vence_em is null then
    raise exception 'Diga o que fazer e quando';
  end if;
  insert into public.tarefas (lead_id, corretor_id, titulo, vence_em, criada_por)
  select p_lead_id, coalesce(l.corretor_id, v_eu), left(trim(p_titulo), 200), p_vence_em, v_eu
  from public.leads l where l.id = p_lead_id
  returning * into v_tarefa;
  return v_tarefa;
end;
$$;

create function public.concluir_tarefa(p_tarefa_id uuid)
returns public.tarefas
language plpgsql security definer set search_path = ''
as $$
declare
  v_tarefa public.tarefas;
begin
  select * into v_tarefa from public.tarefas where id = p_tarefa_id for update;
  if not found or not interno.posso_editar_lead(v_tarefa.lead_id) then
    raise exception 'Tarefa não encontrada ou sem permissão';
  end if;
  if v_tarefa.concluida_em is null then
    update public.tarefas set concluida_em = now() where id = p_tarefa_id returning * into v_tarefa;
    insert into public.atividades (lead_id, corretor_id, tipo, conteudo)
    values (v_tarefa.lead_id, interno.meu_corretor_id(), 'tarefa', v_tarefa.titulo);
  end if;
  return v_tarefa;
end;
$$;

create function public.remarcar_tarefa(p_tarefa_id uuid, p_vence_em timestamptz)
returns public.tarefas
language plpgsql security definer set search_path = ''
as $$
declare
  v_tarefa public.tarefas;
begin
  select * into v_tarefa from public.tarefas where id = p_tarefa_id for update;
  if not found or not interno.posso_editar_lead(v_tarefa.lead_id) then
    raise exception 'Tarefa não encontrada ou sem permissão';
  end if;
  if p_vence_em is null then
    raise exception 'Informe a nova data';
  end if;
  update public.tarefas set vence_em = p_vence_em, avisada_em = null
  where id = p_tarefa_id
  returning * into v_tarefa;
  return v_tarefa;
end;
$$;

-- A ficha é a mesma que a Thais preenche. Chave com valor nulo sai da ficha.
create function public.editar_cliente(
  p_lead_id uuid, p_nome text, p_email text, p_interesse public.lead_interesse, p_temperatura public.lead_temperatura, p_ficha jsonb
)
returns public.leads
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
begin
  if not interno.posso_editar_lead(p_lead_id) then
    raise exception 'Só o corretor do lead ou o gestor podem editar o cliente';
  end if;
  update public.leads
  set nome = nullif(trim(p_nome), ''),
      email = nullif(lower(trim(p_email)), ''),
      interesse = p_interesse,
      temperatura = p_temperatura,
      ficha = jsonb_strip_nulls(ficha || coalesce(p_ficha, '{}'))
  where id = p_lead_id
  returning * into v_lead;
  return v_lead;
end;
$$;

-- Mesmas regras de _shared/telefone.ts.
create function interno.normalizar_whatsapp(p_numero text) returns text
language sql immutable set search_path = ''
as $$
  select case
    when d ~ '^55[0-9]{10,11}$' then d
    when d ~ '^[0-9]{10,11}$' then '55' || d
  end
  from (select regexp_replace(coalesce(p_numero, ''), '[^0-9]', '', 'g') as d) n;
$$;

create function interno.variantes_whatsapp(p_numero text) returns text[]
language sql immutable set search_path = ''
as $$
  select case
    when p_numero ~ '^55[0-9]{2}9[0-9]{8}$' then array[p_numero, left(p_numero, 4) || substr(p_numero, 6)]
    when p_numero ~ '^55[0-9]{10}$' then array[p_numero, left(p_numero, 4) || '9' || substr(p_numero, 5)]
    else array[p_numero]
  end;
$$;

-- Cliente que chegou por outro caminho (telefone, placa, indicação...). Fica com
-- quem cadastrou; o gestor pode escolher o corretor. A IA não fala com ele.
create function public.criar_cliente(
  p_nome text, p_whatsapp text, p_email text default null, p_origem text default 'outro',
  p_interesse public.lead_interesse default null, p_corretor_id uuid default null, p_observacoes text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_numero text := interno.normalizar_whatsapp(p_whatsapp);
  v_existente public.leads;
  v_dono uuid;
  v_id uuid;
begin
  if v_eu is null then
    raise exception 'Entre no painel para cadastrar clientes';
  end if;
  if nullif(trim(p_nome), '') is null then
    raise exception 'Informe o nome do cliente';
  end if;
  if v_numero is null then
    raise exception 'Informe o telefone com DDD, por exemplo (67) 99999-9999';
  end if;

  select * into v_existente from public.leads where whatsapp = any (interno.variantes_whatsapp(v_numero)) limit 1;
  if found then
    return jsonb_build_object(
      'situacao', 'ja_existe',
      'lead_id', case when interno.posso_ver_lead(v_existente.id) then v_existente.id end,
      'corretor_nome', (select c.nome from public.corretores c where c.id = v_existente.corretor_id)
    );
  end if;

  v_dono := case when interno.sou_gestor() then coalesce(p_corretor_id, v_eu) else v_eu end;
  if not exists (select 1 from public.corretores c where c.id = v_dono and c.ativo) then
    raise exception 'Corretor não encontrado ou inativo';
  end if;

  insert into public.leads (whatsapp, nome, email, origem, interesse, ficha, status, corretor_id, ia_ativa)
  values (
    v_numero, trim(p_nome), nullif(lower(trim(p_email)), ''), coalesce(nullif(trim(p_origem), ''), 'outro'), p_interesse,
    jsonb_strip_nulls(jsonb_build_object('observacoes', nullif(trim(p_observacoes), ''))),
    'com_corretor', v_dono, false
  )
  returning id into v_id;
  return jsonb_build_object('situacao', 'criado', 'lead_id', v_id);
end;
$$;

-- Imóveis ativos que combinam com a ficha do cliente, usando a mesma busca da
-- Thais. A região pode ter vários bairros ("Tiradentes ou Moreninha").
create function public.imoveis_compativeis(p_lead_id uuid, p_limite integer default 6)
returns table (
  codigo text, referencia text, tipo text, bairro text, valor numeric, dormitorios integer, vagas integer,
  area_construida numeric, area_terreno numeric, link_site text, foto_principal text,
  na_regiao boolean, acima_do_orcamento boolean, ja_enviado boolean
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lead public.leads;
  v_finalidade text;
  v_tipo text;
  v_regioes text[];
  v_maximo numeric;
  v_minimo numeric;
  v_quartos integer;
begin
  if not interno.posso_ver_lead(p_lead_id) then
    raise exception 'Lead não encontrado ou sem permissão';
  end if;
  select * into v_lead from public.leads l where l.id = p_lead_id;
  v_finalidade := case v_lead.interesse when 'locacao' then 'locacao' when 'compra' then 'venda' end;
  if v_finalidade is null then
    return;
  end if;

  v_tipo := upper(v_lead.ficha ->> 'tipo_imovel');
  if not exists (select 1 from public.imoveis i where i.tipo = v_tipo) then
    v_tipo := null;
  end if;
  v_regioes := array(
    select trim(r)
    from regexp_split_to_table(coalesce(v_lead.ficha ->> 'regiao', ''), '\s*(,|;|/|\s+ou\s+|\s+e\s+)\s*') r
    where trim(r) <> ''
  );
  if cardinality(v_regioes) = 0 then
    v_regioes := array[null::text];
  end if;
  v_maximo := case when v_lead.ficha ->> 'orcamento_max' ~ '^[0-9]+(\.[0-9]+)?$' then (v_lead.ficha ->> 'orcamento_max')::numeric end;
  v_minimo := case when v_lead.ficha ->> 'orcamento_min' ~ '^[0-9]+(\.[0-9]+)?$' then (v_lead.ficha ->> 'orcamento_min')::numeric end;
  v_quartos := case when v_lead.ficha ->> 'quartos' ~ '^[0-9]+$' then (v_lead.ficha ->> 'quartos')::integer end;

  return query
  with achados as (
    select distinct on (b.codigo) b.*
    from unnest(v_regioes) r
    cross join lateral public.ia_buscar_imoveis(
      v_finalidade, v_tipo, r, v_maximo, v_minimo, v_quartos,
      case when v_lead.ficha ->> 'pet' = 'true' then true end, 10
    ) b
    order by b.codigo, b.na_regiao desc
  )
  select
    a.codigo, a.referencia, a.tipo, a.bairro, a.valor, a.dormitorios, a.vagas, a.area_construida, a.area_terreno,
    a.link_site, a.foto_principal, a.na_regiao, a.acima_do_orcamento,
    exists (
      select 1 from public.atividades e
      where e.lead_id = p_lead_id and e.tipo = 'imovel_enviado' and e.dados ->> 'codigo' = a.codigo
    )
  from achados a
  order by a.acima_do_orcamento, a.na_regiao desc, abs(a.valor - coalesce(v_maximo, a.valor)), a.codigo
  limit least(greatest(coalesce(p_limite, 6), 1), 12);
end;
$$;

-- Lead encerrado continua contando como assumido no resumo do mês.
create or replace function public.painel_resumo(p_desde timestamptz) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with leads_periodo as (
    select * from public.leads where criado_em >= p_desde and whatsapp not like 'sim-%'
  ),
  respostas as (
    select extract(epoch from (ia.criado_em - cli.criado_em)) as segundos
    from public.mensagens ia
    join lateral (
      select c.criado_em from public.mensagens c
      where c.lead_id = ia.lead_id and c.autor = 'cliente' and c.id < ia.id
      order by c.id desc limit 1
    ) cli on true
    join leads_periodo l on l.id = ia.lead_id
    where ia.autor = 'ia'
  ),
  assumidas as (
    select extract(epoch from (a.respondida_em - a.oferecida_em)) as segundos
    from public.atribuicoes a
    join leads_periodo l on l.id = a.lead_id
    where a.status = 'aceita'
  )
  select jsonb_build_object(
    'leads', (select count(*) from leads_periodo),
    'qualificados', (select count(*) from leads_periodo where interesse is not null and ficha ? 'regiao' and (ficha ? 'orcamento_max' or ficha ? 'orcamento_min')),
    'passados', (select count(distinct a.lead_id) from public.atribuicoes a join leads_periodo l on l.id = a.lead_id),
    'assumidos', (select count(*) from leads_periodo where corretor_id is not null),
    'aguardando', (select count(*) from public.leads where status = 'aguardando_corretor' and whatsapp not like 'sim-%'),
    'prazos_vencidos', (select count(*) from public.atribuicoes a join leads_periodo l on l.id = a.lead_id where a.status = 'expirada'),
    'quentes', (select count(*) from leads_periodo where temperatura = 'quente'),
    'resposta_ia_segundos', (select round(avg(segundos)::numeric, 1) from respostas),
    'assumir_segundos', (select round(avg(segundos)::numeric, 0) from assumidas)
  );
$$;

revoke execute on function public.mudar_etapa(uuid, public.lead_etapa, text, numeric) from public, anon;
revoke execute on function public.registrar_atividade(uuid, text, text, jsonb) from public, anon;
revoke execute on function public.criar_tarefa(uuid, text, timestamptz) from public, anon;
revoke execute on function public.concluir_tarefa(uuid) from public, anon;
revoke execute on function public.remarcar_tarefa(uuid, timestamptz) from public, anon;
revoke execute on function public.editar_cliente(uuid, text, text, public.lead_interesse, public.lead_temperatura, jsonb) from public, anon;
revoke execute on function public.criar_cliente(text, text, text, text, public.lead_interesse, uuid, text) from public, anon;
revoke execute on function public.imoveis_compativeis(uuid, integer) from public, anon;
grant execute on function public.mudar_etapa(uuid, public.lead_etapa, text, numeric) to authenticated;
grant execute on function public.registrar_atividade(uuid, text, text, jsonb) to authenticated;
grant execute on function public.criar_tarefa(uuid, text, timestamptz) to authenticated;
grant execute on function public.concluir_tarefa(uuid) to authenticated;
grant execute on function public.remarcar_tarefa(uuid, timestamptz) to authenticated;
grant execute on function public.editar_cliente(uuid, text, text, public.lead_interesse, public.lead_temperatura, jsonb) to authenticated;
grant execute on function public.criar_cliente(text, text, text, text, public.lead_interesse, uuid, text) to authenticated;
grant execute on function public.imoveis_compativeis(uuid, integer) to authenticated;
