-- Prazo para responder: depois de assumir o lead, o corretor tem N minutos
-- (configuracoes.prazo_resposta_minutos, padrão 5) para mandar a primeira
-- mensagem pelo sistema. Se não mandar, o lead volta ao rodízio, o histórico
-- registra a perda e o corretor é avisado. É separado do prazo para assumir
-- (prazo_rodizio_minutos), que continua igual.

insert into public.configuracoes (chave, valor, descricao)
values ('prazo_resposta_minutos', '5'::jsonb, 'Minutos para o corretor mandar a primeira mensagem depois de assumir o lead')
on conflict (chave) do nothing;

-- O histórico do lead ganha o tipo "prazo" (perda de prazo e redistribuição).
do $$
declare v_nome text;
begin
  select conname into v_nome from pg_constraint
  where conrelid = 'public.atividades'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%imovel_enviado%';
  if v_nome is not null then
    execute format('alter table public.atividades drop constraint %I', v_nome);
  end if;
end $$;
alter table public.atividades add constraint atividades_tipo_check
  check (tipo in ('nota', 'ligacao', 'visita', 'proposta', 'etapa', 'tarefa', 'imovel_enviado', 'prazo'));

-- Qual prazo cada oferta perdeu e até quando o corretor tinha para responder.
alter table public.atribuicoes
  add column prazo_resposta_em timestamptz,
  add column perdeu_prazo text check (perdeu_prazo in ('assumir', 'responder'));

-- Ao assumir, começa a contar o prazo para responder.
create or replace function interno.aceitar_atribuicao(p_atribuicao_id uuid, p_corretor_id uuid)
 returns public.leads
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_atribuicao public.atribuicoes;
  v_lead public.leads;
  v_minutos integer := coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_resposta_minutos'), 5);
begin
  select * into v_atribuicao from public.atribuicoes where id = p_atribuicao_id for update;
  if not found or v_atribuicao.corretor_id is distinct from p_corretor_id then
    raise exception 'Atribuição não encontrada para este corretor';
  end if;
  if v_atribuicao.status <> 'pendente' then
    raise exception 'Este lead já não está disponível para você (situação: %)', v_atribuicao.status;
  end if;

  update public.atribuicoes
  set status = 'aceita', respondida_em = now(), prazo_resposta_em = now() + make_interval(mins => v_minutos)
  where id = p_atribuicao_id;
  update public.leads
  set corretor_id = p_corretor_id, status = 'com_corretor', ia_ativa = false
  where id = v_atribuicao.lead_id
  returning * into v_lead;
  return v_lead;
end;
$function$;

-- Registro no histórico do lead (atividades, tipo "prazo"), visível no painel.
create or replace function interno.registrar_prazo_perdido(p_atribuicao public.atribuicoes, p_prazo text, p_oferta jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_nome text := (select c.nome from public.corretores c where c.id = p_atribuicao.corretor_id);
  v_destino text := case p_oferta ->> 'situacao'
    when 'oferecido' then 'Lead oferecido a ' || coalesce(p_oferta ->> 'corretor_nome', 'outro corretor') || '.'
    when 'sem_corretor_disponivel' then 'Não há outro corretor de plantão agora; o lead fica aguardando.'
    else 'Lead devolvido ao rodízio.'
  end;
begin
  insert into public.atividades (lead_id, corretor_id, tipo, conteudo, dados)
  values (
    p_atribuicao.lead_id, null, 'prazo',
    coalesce(v_nome, 'O corretor') || case p_prazo
      when 'assumir' then ' perdeu o prazo para assumir o lead. '
      else ' assumiu, mas perdeu o prazo para responder (não mandou mensagem a tempo). '
    end || v_destino,
    jsonb_build_object('prazo', p_prazo, 'corretor_id', p_atribuicao.corretor_id, 'atribuicao_id', p_atribuicao.id, 'oferta', p_oferta)
  );
end;
$function$;

-- Roda a cada minuto (cron "prazos-rodizio"): os dois prazos.
create or replace function interno.processar_prazos_rodizio()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_expirada public.atribuicoes;
  v_oferta jsonb;
  v_total integer := 0;
begin
  -- 1) Prazo para assumir.
  for v_expirada in
    update public.atribuicoes set status = 'expirada', perdeu_prazo = 'assumir'
    where status = 'pendente' and prazo_em < now()
    returning *
  loop
    v_oferta := public.oferecer_lead(v_expirada.lead_id);
    perform interno.registrar_prazo_perdido(v_expirada, 'assumir', v_oferta);
    v_total := v_total + 1;
  end loop;

  -- 2) Prazo para responder: assumiu e não mandou mensagem pelo sistema.
  for v_expirada in
    update public.atribuicoes a set status = 'expirada', perdeu_prazo = 'responder'
    where a.status = 'aceita' and a.prazo_resposta_em < now()
      and exists (
        select 1 from public.leads l
        where l.id = a.lead_id and l.corretor_id = a.corretor_id and l.status = 'com_corretor'
      )
      and not exists (
        select 1 from public.mensagens m
        where m.lead_id = a.lead_id and m.autor = 'corretor' and m.criado_em >= a.respondida_em
      )
    returning a.*
  loop
    -- Volta a ser um lead sem dono; a IA segue atendendo até o próximo assumir.
    update public.leads set corretor_id = null, status = 'aguardando_corretor', ia_ativa = true
    where id = v_expirada.lead_id;
    v_oferta := public.oferecer_lead(v_expirada.lead_id);
    perform interno.registrar_prazo_perdido(v_expirada, 'responder', v_oferta);
    -- Avisa o corretor que perdeu (notificação e, se der, WhatsApp).
    perform net.http_post(
      url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
      body := jsonb_build_object('prazo_perdido_id', v_expirada.id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
      ),
      timeout_milliseconds := 15000
    );
    v_total := v_total + 1;
  end loop;

  -- Quem já respondeu não precisa mais do relógio.
  update public.atribuicoes a set prazo_resposta_em = null
  where a.status = 'aceita' and a.prazo_resposta_em is not null
    and exists (
      select 1 from public.mensagens m
      where m.lead_id = a.lead_id and m.autor = 'corretor' and m.criado_em >= a.respondida_em
    );
  return v_total;
end;
$function$;

-- As regras do rodízio que o painel lê passam a trazer os dois prazos.
create or replace function public.regras_do_rodizio()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select case when interno.meu_corretor_id() is null then null else
    coalesce((select c.valor from public.configuracoes c where c.chave = 'rodizio'), '{}'::jsonb)
    || jsonb_build_object(
      'prazo_minutos', coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 5),
      'prazo_resposta_minutos', coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_resposta_minutos'), 5)
    )
  end;
$function$;
