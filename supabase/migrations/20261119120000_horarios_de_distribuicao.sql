-- Horários de distribuição (pedido de 19/11), no fuso da empresa:
--   * comercial: segunda a sexta, 08:00 às 17:00 -> rodízio com todos do rodízio;
--   * plantão: dias úteis das 17:00 às 22:00 e sábado/domingo das 08:00 às 22:00
--     -> rodízio só com quem ligou o botão Plantão;
--   * fora do horário: 22:00 às 08:00 -> sem rodízio. O captador do imóvel é
--     avisado na hora, mas o prazo dele só começa às 08:00. Lead sem captador
--     espera e entra no fluxo às 08:00. Nada vence nem é redistribuído.
-- O captador é sempre o primeiro, em qualquer horário, com ou sem plantão.
-- Substitui a pausa noturna (00:00 às 06:00): em_pausa() e fim_da_pausa() passam
-- a significar "fora do horário", e quem já usa essas funções segue funcionando.
-- Só o gestor muda os horários e liga/desliga a janela "fora do horário".

insert into public.configuracoes (chave, valor)
values ('horarios_distribuicao', '{"dias": [1, 2, 3, 4, 5], "inicio": "08:00", "fim_comercial": "17:00", "fim_plantao": "22:00", "fora_ativo": true}'::jsonb)
on conflict (chave) do nothing;

create or replace function interno.horarios()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select '{"dias": [1, 2, 3, 4, 5], "inicio": "08:00", "fim_comercial": "17:00", "fim_plantao": "22:00", "fora_ativo": true}'::jsonb
    || coalesce((select c.valor from public.configuracoes c where c.chave = 'horarios_distribuicao'), '{}'::jsonb);
$$;

-- 'comercial', 'plantao' ou 'fora' neste instante.
create or replace function interno.periodo(p_quando timestamptz)
 returns text
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_cfg jsonb := interno.horarios();
  v_local timestamp := p_quando at time zone interno.fuso();
  v_hora time := v_local::time;
begin
  if coalesce((v_cfg ->> 'fora_ativo')::boolean, true)
     and (v_hora >= (v_cfg ->> 'fim_plantao')::time or v_hora < (v_cfg ->> 'inicio')::time) then
    return 'fora';
  end if;
  if (v_cfg -> 'dias') @> to_jsonb(extract(isodow from v_local)::integer)
     and v_hora >= (v_cfg ->> 'inicio')::time and v_hora < (v_cfg ->> 'fim_comercial')::time then
    return 'comercial';
  end if;
  return 'plantao';
end;
$$;

-- Compatibilidade: a antiga pausa noturna agora é a janela "fora do horário".
create or replace function interno.em_pausa(p_quando timestamptz)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select interno.periodo(p_quando) = 'fora';
$$;

-- Próxima abertura (08:00) depois deste instante.
create or replace function interno.fim_da_pausa(p_quando timestamptz)
 returns timestamptz
 language sql
 stable security definer
 set search_path to ''
as $$
  select case
    when ((p_quando at time zone interno.fuso())::date + (h ->> 'inicio')::time) at time zone interno.fuso() > p_quando
      then ((p_quando at time zone interno.fuso())::date + (h ->> 'inicio')::time) at time zone interno.fuso()
    else (((p_quando at time zone interno.fuso())::date + 1) + (h ->> 'inicio')::time) at time zone interno.fuso()
  end
  from (select interno.horarios() h) x;
$$;

-- Quem entra no rodízio agora: no comercial, todos do rodízio; no plantão, só
-- quem ligou o botão; fora do horário, ninguém.
create or replace function interno.entra_no_rodizio_agora(p_de_plantao boolean)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select case interno.periodo(now())
    when 'comercial' then true
    when 'plantao' then coalesce(p_de_plantao, false)
    else false
  end;
$$;

do $$
declare v_def text;
begin
  select pg_get_functiondef('interno.fila_do_rodizio'::regproc) into v_def;
  v_def := replace(v_def, 'where c.ativo and c.no_rodizio and c.de_plantao',
                          'where c.ativo and c.no_rodizio and interno.entra_no_rodizio_agora(c.de_plantao)');
  if v_def not like '%interno.entra_no_rodizio_agora(c.de_plantao)%' then
    raise exception 'fila_do_rodizio: trecho não encontrado';
  end if;
  execute v_def;
end $$;

-- Oferta criada fora do horário (só o captador chega aqui): o aviso sai na hora,
-- mas o prazo para assumir começa às 08:00.
create or replace function interno.oferta_na_pausa()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  new.aviso_pendente := false;
  if new.status = 'pendente' and interno.periodo(now()) = 'fora' then
    -- Marca o começo da janela já aqui, para a retomada não empurrar este prazo.
    update interno.pausa_estado set desde = coalesce(desde, now()) where id;
    new.prazo_em := interno.fim_da_pausa(now())
      + make_interval(mins => coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 15));
  end if;
  return new;
end;
$$;

-- Fim da janela "fora do horário" (ou janela desligada): prazos que corriam
-- antes dela voltam com o tempo que faltava; prazos criados durante ela (o do
-- captador já começa às 08:00; o de responder de quem assumiu de madrugada)
-- começam agora.
create or replace function interno.retomar_depois_da_pausa()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_desde timestamptz;
  v_parado interval;
  v_minutos integer := coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 15);
  v_resposta integer := coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_resposta_minutos'), 5);
  v_oferta public.atribuicoes;
  v_total integer := 0;
begin
  if interno.periodo(now()) = 'fora' then
    return 0;
  end if;

  select desde into v_desde from interno.pausa_estado where id for update;
  if v_desde is not null then
    v_parado := now() - v_desde;
    update public.atribuicoes set prazo_em = prazo_em + v_parado
    where status = 'pendente' and not aviso_pendente and prazo_em > v_desde and oferecida_em < v_desde;
    update public.atribuicoes set prazo_resposta_em = prazo_resposta_em + v_parado
    where status = 'aceita' and prazo_resposta_em is not null and prazo_resposta_em > v_desde and respondida_em < v_desde;
    update public.atribuicoes set prazo_resposta_em = now() + make_interval(mins => v_resposta)
    where status = 'aceita' and prazo_resposta_em is not null and respondida_em >= v_desde;
    -- Oferta ao captador criada fora do horário com prazo vencido antes da hora (janela encurtada): ganha o prazo cheio.
    update public.atribuicoes set prazo_em = now() + make_interval(mins => v_minutos)
    where status = 'pendente' and oferecida_em >= v_desde and prazo_em < now();
    update interno.pausa_estado set desde = null where id;
  end if;

  -- Avisos guardados pela pausa antiga (não acontece mais; fica para não perder nenhum).
  for v_oferta in
    update public.atribuicoes
    set aviso_pendente = false,
        prazo_em = case when status = 'pendente' then now() + make_interval(mins => v_minutos) else prazo_em end
    where aviso_pendente
    returning *
  loop
    if v_oferta.status = 'pendente' then
      perform net.http_post(
        url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
        body := jsonb_build_object('atribuicao_id', v_oferta.id),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
        ),
        timeout_milliseconds := 15000
      );
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$$;

-- Leads que esperam sem oferta (chegaram fora do horário sem captador, ou
-- ninguém estava disponível): entram no fluxo assim que houver quem receba.
create or replace function interno.oferecer_leads_em_espera()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_lead record;
  v_oferta jsonb;
  v_total integer := 0;
begin
  if interno.periodo(now()) = 'fora' then
    return 0;
  end if;
  for v_lead in
    select l.id from public.leads l
    where l.status = 'aguardando_corretor'
      and l.whatsapp not like 'sim-%'
      and l.ultima_mensagem_cliente_em > now() - interval '7 days'
      and not exists (select 1 from public.atribuicoes a where a.lead_id = l.id and a.status = 'pendente')
    order by l.status_desde nulls first
  loop
    v_oferta := public.oferecer_lead(v_lead.id);
    if v_oferta ->> 'situacao' = 'oferecido' then
      insert into public.mensagens (lead_id, autor, conteudo)
      values (v_lead.id, 'sistema', 'Lead em espera oferecido para ' || (v_oferta ->> 'corretor_nome') || ' (' || interno.periodo(now()) || ')');
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$$;

-- Job de todo minuto: depois de retomar, oferece quem estava esperando.
do $$
declare v_def text;
begin
  select pg_get_functiondef('interno.processar_prazos_rodizio'::regproc) into v_def;
  v_def := replace(v_def, '  perform interno.retomar_depois_da_pausa();
', '  perform interno.retomar_depois_da_pausa();
  perform interno.oferecer_leads_em_espera();
');
  if v_def not like '%perform interno.oferecer_leads_em_espera();%' then
    raise exception 'processar_prazos_rodizio: trecho não encontrado';
  end if;
  execute v_def;
end $$;

-- Painel: regras do rodízio trazem os horários e o período de agora.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.regras_do_rodizio'::regproc) into v_def;
  v_def := replace(v_def, $a$'em_pausa', interno.em_pausa(now())$a$,
    $a$'em_pausa', interno.em_pausa(now()),
      'horarios', interno.horarios(),
      'periodo', interno.periodo(now()),
      'volta_em', interno.fim_da_pausa(now())$a$);
  if v_def not like '%''periodo'', interno.periodo(now())%' then
    raise exception 'regras_do_rodizio: trecho não encontrado';
  end if;
  execute v_def;
end $$;

-- Para a IA (chave de servidor): período de agora e quando os corretores voltam.
create or replace function public.periodo_de_atendimento()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select jsonb_build_object('periodo', interno.periodo(now()), 'volta_em', interno.fim_da_pausa(now()), 'horarios', interno.horarios());
$$;
revoke all on function public.periodo_de_atendimento() from public, anon, authenticated;
grant execute on function public.periodo_de_atendimento() to service_role;

create or replace function public.salvar_horarios_distribuicao(
  p_dias integer[], p_inicio text, p_fim_comercial text, p_fim_plantao text, p_fora_ativo boolean
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_valor jsonb;
  v_formato text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor muda os horários de distribuição';
  end if;
  if coalesce(p_inicio, '') !~ v_formato or coalesce(p_fim_comercial, '') !~ v_formato or coalesce(p_fim_plantao, '') !~ v_formato then
    raise exception 'Informe os horários no formato HH:MM';
  end if;
  if not (p_inicio::time < p_fim_comercial::time and p_fim_comercial::time <= p_fim_plantao::time) then
    raise exception 'A ordem precisa ser: início < fim do comercial <= fim do plantão';
  end if;
  if p_dias is null or cardinality(p_dias) = 0 or exists (select 1 from unnest(p_dias) d where d not between 1 and 7) then
    raise exception 'Escolha pelo menos um dia de horário comercial';
  end if;
  v_valor := jsonb_build_object(
    'dias', (select jsonb_agg(distinct d order by d) from unnest(p_dias) d),
    'inicio', p_inicio, 'fim_comercial', p_fim_comercial, 'fim_plantao', p_fim_plantao,
    'fora_ativo', coalesce(p_fora_ativo, true)
  );
  insert into public.configuracoes (chave, valor) values ('horarios_distribuicao', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  perform interno.retomar_depois_da_pausa();
  return v_valor;
end;
$$;
revoke all on function public.salvar_horarios_distribuicao(integer[], text, text, text, boolean) from public, anon;
grant execute on function public.salvar_horarios_distribuicao(integer[], text, text, text, boolean) to authenticated;

-- A configuração só o gestor muda (o administrativo também não).
drop policy if exists "Gestor altera as configurações" on public.configuracoes;
create policy "Gestor altera as configurações" on public.configuracoes for update to authenticated
  using ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna', 'horarios_distribuicao')))
  with check ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna', 'horarios_distribuicao')));

-- A pausa antiga (00:00 às 06:00) sai de cena.
drop function if exists public.salvar_pausa_noturna(boolean, text, text);
delete from public.configuracoes where chave = 'pausa_noturna';
