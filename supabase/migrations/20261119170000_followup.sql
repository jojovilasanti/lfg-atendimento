-- Follow-up da Thais (pedido de 19/11): quando o cliente para de responder a
-- Thais, ela manda até 5 mensagens, só no horário comercial (dias e horário de
-- horarios_distribuicao), em cerca de 3 dias úteis, nunca um dia inteiro sem
-- mensagem. Depois da 5ª, o atendimento é finalizado ("Sem resposta do cliente").
--
-- A sequência para (e zera) quando: o cliente escreve; um corretor assume ou a
-- IA é desligada; o atendimento é finalizado. Se o cliente parar de novo, ela
-- recomeça da 1ª.
--
-- Envio: o banco grava a mensagem (tipo 'followup') e a função avisos manda.
-- Até 23 h depois da última mensagem do cliente vai como texto livre; depois,
-- como mensagem-modelo aprovada pela Meta (thais_followup_1 a 5).
-- O gestor edita os textos, os intervalos e liga/desliga.

insert into public.configuracoes (chave, valor)
values ('followup', jsonb_build_object(
  'ativo', false, -- liga depois que a Meta aprovar os 5 modelos
  'mensagens', jsonb_build_array(
    'Ainda não tive sua resposta. Quando quiser, estou aqui para te ajudar.',
    'O dia deve estar bem corrido, eu entendo. Mas sigo à disposição para te atender.',
    'Caso prefira conversar outro dia, é só me avisar qual o melhor momento para falarmos, ok?',
    'Não tive resposta. Talvez não seja o melhor momento para conversar.',
    'Como não conseguimos prosseguir, estou finalizando seu atendimento. Se precisar, a LFG Imóveis está à disposição.'
  ),
  -- Quando sai cada mensagem: X horas depois da anterior (a 1ª, depois da
  -- última mensagem da Thais) ou no dia útil seguinte num horário.
  'passos', jsonb_build_array(
    jsonb_build_object('apos_horas', 2),
    jsonb_build_object('apos_horas', 4),
    jsonb_build_object('proximo_dia', '08:30'),
    jsonb_build_object('apos_horas', 6),
    jsonb_build_object('proximo_dia', '08:30')
  )
))
on conflict (chave) do nothing;

alter table public.leads add column if not exists followup_etapa smallint not null default 0;
alter table public.leads add column if not exists followup_proximo timestamptz;
alter table public.mensagens add column if not exists followup_n smallint;
comment on column public.leads.followup_etapa is 'Quantas mensagens de follow-up já saíram nesta sequência (0 a 5).';
comment on column public.leads.followup_proximo is 'Quando sai a próxima mensagem de follow-up.';

-- Dentro do horário comercial (dias úteis da configuração, abertura até o fim do comercial).
create or replace function interno.no_comercial(p_quando timestamptz)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select (h -> 'dias') @> to_jsonb(extract(isodow from (p_quando at time zone interno.fuso()))::integer)
     and (p_quando at time zone interno.fuso())::time >= (h ->> 'inicio')::time
     and (p_quando at time zone interno.fuso())::time < (h ->> 'fim_comercial')::time
  from (select interno.horarios() h) x;
$$;

-- O próprio instante, se já for horário comercial; senão, a próxima abertura.
create or replace function interno.proxima_abertura(p_quando timestamptz)
 returns timestamptz
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_h jsonb := interno.horarios();
  v_dia date := (p_quando at time zone interno.fuso())::date;
  v_inicio timestamptz;
begin
  if interno.no_comercial(p_quando) then
    return p_quando;
  end if;
  for i in 0..14 loop
    v_inicio := ((v_dia + i) + (v_h ->> 'inicio')::time) at time zone interno.fuso();
    if v_inicio > p_quando and (v_h -> 'dias') @> to_jsonb(extract(isodow from (v_dia + i))::integer) then
      return v_inicio;
    end if;
  end loop;
  return p_quando + interval '1 day';
end;
$$;

-- Dia útil seguinte (depois do dia deste instante) no horário pedido.
create or replace function interno.proximo_dia_util_as(p_quando timestamptz, p_hora text)
 returns timestamptz
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_h jsonb := interno.horarios();
  v_dia date := (p_quando at time zone interno.fuso())::date;
begin
  for i in 1..15 loop
    if (v_h -> 'dias') @> to_jsonb(extract(isodow from (v_dia + i))::integer) then
      return interno.proxima_abertura(((v_dia + i) + coalesce(p_hora, '08:30')::time) at time zone interno.fuso());
    end if;
  end loop;
  return interno.proxima_abertura(p_quando + interval '1 day');
end;
$$;

create or replace function interno.agendar_followup(p_base timestamptz, p_passo jsonb)
 returns timestamptz
 language sql
 stable security definer
 set search_path to ''
as $$
  select case
    when p_passo ? 'proximo_dia' then interno.proximo_dia_util_as(p_base, p_passo ->> 'proximo_dia')
    else interno.proxima_abertura(p_base + make_interval(mins => round(coalesce((p_passo ->> 'apos_horas')::numeric, 2) * 60)::integer))
  end;
$$;

-- O cliente escreveu: a sequência zera.
create or replace function interno.zerar_followup_ao_escrever()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  update public.leads set followup_etapa = 0, followup_proximo = null
  where id = new.lead_id and (followup_etapa <> 0 or followup_proximo is not null);
  return null;
end;
$$;
drop trigger if exists mensagens_zerar_followup on public.mensagens;
create trigger mensagens_zerar_followup
  after insert on public.mensagens
  for each row when (new.autor = 'cliente')
  execute function interno.zerar_followup_ao_escrever();

-- Corretor assumiu, IA desligada, atendimento finalizado (qualquer mudança de
-- situação): a sequência zera.
create or replace function interno.zerar_followup_do_lead()
 returns trigger
 language plpgsql
 set search_path to ''
as $$
begin
  if new.status is distinct from old.status or (old.ia_ativa and not new.ia_ativa) then
    new.followup_etapa := 0;
    new.followup_proximo := null;
  end if;
  return new;
end;
$$;
drop trigger if exists leads_zerar_followup on public.leads;
create trigger leads_zerar_followup
  before update of status, ia_ativa on public.leads
  for each row execute function interno.zerar_followup_do_lead();

-- Job de todo minuto (só age no horário comercial).
create or replace function interno.processar_followup(p_incluir_testes boolean default false)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_cfg jsonb := (select c.valor from public.configuracoes c where c.chave = 'followup');
  v_lead record;
  v_etapa integer;
  v_total integer := 0;
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'ativo')::boolean, false) then
    return 0;
  end if;
  if not interno.no_comercial(now()) then
    return 0;
  end if;

  for v_lead in
    select l.id, l.followup_etapa, l.followup_proximo, u.criado_em as ultima_em
    from public.leads l
    cross join lateral (
      select m.autor, m.criado_em from public.mensagens m
      where m.lead_id = l.id and m.autor <> 'sistema'
      order by m.criado_em desc, m.id desc limit 1
    ) u
    where l.status = 'em_atendimento_ia' and l.ia_ativa
      and (p_incluir_testes or l.whatsapp not like 'sim-%')
      and u.autor = 'ia'
      and l.followup_etapa < 5
      and exists (select 1 from public.mensagens c where c.lead_id = l.id and c.autor = 'cliente')
    for update of l skip locked
  loop
    if v_lead.followup_proximo is null then
      -- Só começa para quem parou de responder há pouco (nada de mandar para
      -- conversas antigas quando o follow-up é ligado).
      continue when v_lead.ultima_em < now() - interval '24 hours';
      update public.leads set followup_proximo = interno.agendar_followup(v_lead.ultima_em, v_cfg -> 'passos' -> 0)
      where id = v_lead.id;
      continue;
    end if;
    continue when now() < v_lead.followup_proximo;

    v_etapa := v_lead.followup_etapa + 1;
    insert into public.mensagens (lead_id, autor, tipo, conteudo, status_entrega, followup_n)
    values (v_lead.id, 'ia', 'followup', v_cfg -> 'mensagens' ->> (v_etapa - 1), 'pendente', v_etapa);
    v_total := v_total + 1;

    if v_etapa >= 5 then
      update public.leads
      set etapa = 'perdido', status = 'encerrado', ia_ativa = false, motivo_perda = 'Sem resposta do cliente'
      where id = v_lead.id;
      insert into public.mensagens (lead_id, autor, conteudo)
      values (v_lead.id, 'sistema', 'Atendimento finalizado automaticamente: sem resposta do cliente depois de 5 mensagens de follow-up.');
    else
      update public.leads
      set followup_etapa = v_etapa,
          followup_proximo = interno.agendar_followup(now(), v_cfg -> 'passos' -> v_etapa)
      where id = v_lead.id;
    end if;
  end loop;
  return v_total;
end;
$$;

-- Envio pelo mesmo caminho dos avisos ao cliente.
drop trigger if exists mensagens_enviar_acompanhamento on public.mensagens;
create trigger mensagens_enviar_acompanhamento
  after insert on public.mensagens
  for each row when (new.tipo = any (array['acompanhamento', 'avaliacao', 'followup']))
  execute function interno.enviar_acompanhamento();

-- Quem saiu por falta de resposta não recebe o pedido de avaliação.
update public.configuracoes
set valor = jsonb_set(valor, '{motivos_sem_avaliacao}', (coalesce(valor -> 'motivos_sem_avaliacao', '[]'::jsonb)) || '["Sem resposta do cliente"]'::jsonb)
where chave = 'avaliacao' and not (coalesce(valor -> 'motivos_sem_avaliacao', '[]'::jsonb) ? 'Sem resposta do cliente');

-- Configuração no painel: só o gestor.
create or replace function public.salvar_followup(p_ativo boolean, p_mensagens text[], p_passos jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_valor jsonb;
  v_passo jsonb;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor muda o follow-up';
  end if;
  if p_mensagens is null or cardinality(p_mensagens) <> 5
     or exists (select 1 from unnest(p_mensagens) t where length(trim(coalesce(t, ''))) not between 2 and 1000) then
    raise exception 'Preencha as 5 mensagens (até 1000 caracteres cada)';
  end if;
  if jsonb_typeof(p_passos) <> 'array' or jsonb_array_length(p_passos) <> 5 then
    raise exception 'Informe quando sai cada uma das 5 mensagens';
  end if;
  for v_passo in select * from jsonb_array_elements(p_passos) loop
    if not ((v_passo ? 'apos_horas' and (v_passo ->> 'apos_horas')::numeric between 0.5 and 24)
         or (v_passo ? 'proximo_dia' and (v_passo ->> 'proximo_dia') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) then
      raise exception 'Cada mensagem sai de 0,5 a 24 horas depois da anterior ou no dia útil seguinte num horário (HH:MM)';
    end if;
  end loop;
  v_valor := jsonb_build_object('ativo', coalesce(p_ativo, false), 'mensagens', to_jsonb(array(select trim(t) from unnest(p_mensagens) t)), 'passos', p_passos);
  insert into public.configuracoes (chave, valor) values ('followup', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  return v_valor;
end;
$$;
revoke all on function public.salvar_followup(boolean, text[], jsonb) from public, anon;
grant execute on function public.salvar_followup(boolean, text[], jsonb) to authenticated;

drop policy if exists "Gestor altera as configurações" on public.configuracoes;
create policy "Gestor altera as configurações" on public.configuracoes for update to authenticated
  using ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna', 'horarios_distribuicao', 'followup')))
  with check ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna', 'horarios_distribuicao', 'followup')));

select cron.schedule('followup-thais', '* * * * *', 'select interno.processar_followup()');
