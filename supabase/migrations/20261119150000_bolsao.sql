-- Bolsão (pedido de 19/11). Ordem da distribuição:
--   1. captador do imóvel (sempre o primeiro);
--   2. rodízio, no máximo 2 corretores;
--   3. bolsão: qualquer corretor vê e assume. A trava é no banco: dois cliques ao
--      mesmo tempo dão um só responsável; o outro recebe "Este lead já foi
--      assumido por outro corretor".
-- Também vai para o bolsão o lead sem ninguém para receber no horário comercial
-- ou no plantão. Fora do horário (22h às 8h) ele espera a abertura.
-- Gestor e administrativo reatribuem (passar_lead passa a valer para os dois).

alter type public.atribuicao_motivo add value if not exists 'bolsao';

alter table public.leads add column if not exists bolsao_desde timestamptz;
comment on column public.leads.bolsao_desde is 'Desde quando o lead está no bolsão (null = fora do bolsão).';
create index if not exists leads_no_bolsao on public.leads (bolsao_desde) where bolsao_desde is not null;

-- Saiu de "aguardando corretor" (assumido, finalizado, voltou para a IA): sai do bolsão.
create or replace function interno.sair_do_bolsao()
 returns trigger
 language plpgsql
 set search_path to ''
as $$
begin
  if new.status <> 'aguardando_corretor' then
    new.bolsao_desde := null;
  end if;
  return new;
end;
$$;
drop trigger if exists leads_sair_do_bolsao on public.leads;
create trigger leads_sair_do_bolsao
  before update of status on public.leads
  for each row execute function interno.sair_do_bolsao();

-- Distribuição: captador, até 2 do rodízio, depois bolsão.
create or replace function public.oferecer_lead(p_lead_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_lead public.leads;
  v_pendente public.atribuicoes;
  v_corretor public.corretores;
  v_motivo public.atribuicao_motivo := 'rodizio';
  v_prazo_minutos integer;
  v_do_rodizio integer;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead % não existe', p_lead_id;
  end if;

  if v_lead.status = 'com_corretor' then
    select * into v_corretor from public.corretores where id = v_lead.corretor_id;
    return jsonb_build_object('situacao', 'com_corretor', 'corretor_nome', v_corretor.nome);
  end if;

  select * into v_pendente from public.atribuicoes where lead_id = p_lead_id and status = 'pendente';
  if found then
    select * into v_corretor from public.corretores where id = v_pendente.corretor_id;
    return jsonb_build_object(
      'situacao', 'ja_oferecido',
      'atribuicao_id', v_pendente.id,
      'corretor_nome', v_corretor.nome,
      'prazo_em', v_pendente.prazo_em,
      'motivo', v_pendente.motivo
    );
  end if;

  if v_lead.status = 'aguardando_corretor' and v_lead.bolsao_desde is not null then
    return jsonb_build_object('situacao', 'bolsao', 'desde', v_lead.bolsao_desde);
  end if;

  update public.leads set status = 'aguardando_corretor' where id = p_lead_id;

  -- 1. Captador do imóvel, em qualquer horário.
  if v_lead.imovel_codigo is not null then
    select c.* into v_corretor
    from public.imoveis i
    join public.corretores c on c.id = interno.corretor_do_captador(i.captador)
    where i.codigo = v_lead.imovel_codigo
      and c.whatsapp is not null
      and not exists (select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.corretor_id = c.id);
    if v_corretor.id is not null then
      v_motivo := 'captador';
    end if;
  end if;

  -- 2. Rodízio: no máximo 2 corretores neste atendimento.
  if v_corretor.id is null then
    select count(*) into v_do_rodizio from public.atribuicoes a
    where a.lead_id = p_lead_id and a.motivo = 'rodizio'
      and a.oferecida_em >= coalesce(v_lead.status_desde, '-infinity'::timestamptz);
    if v_do_rodizio < 2 then
      select c.* into v_corretor
      from interno.fila_do_rodizio(p_lead_id) f
      join public.corretores c on c.id = f.corretor_id
      order by f.posicao
      limit 1;
    end if;
  end if;

  -- 3. Ninguém: bolsão (fora do horário, espera a abertura).
  if v_corretor.id is null then
    if interno.periodo(now()) = 'fora' and coalesce(v_do_rodizio, 0) < 2 then
      return jsonb_build_object('situacao', 'sem_corretor_disponivel');
    end if;
    update public.leads set bolsao_desde = now() where id = p_lead_id;
    insert into public.mensagens (lead_id, autor, conteudo)
    values (p_lead_id, 'sistema', 'Lead foi para o bolsão: qualquer corretor pode assumir.');
    return jsonb_build_object('situacao', 'bolsao', 'desde', now());
  end if;

  select (valor #>> '{}')::integer into v_prazo_minutos
  from public.configuracoes where chave = 'prazo_rodizio_minutos';

  insert into public.atribuicoes (lead_id, corretor_id, prazo_em, motivo)
  values (p_lead_id, v_corretor.id, now() + make_interval(mins => coalesce(v_prazo_minutos, 5)), v_motivo)
  returning * into v_pendente;

  return jsonb_build_object(
    'situacao', 'oferecido',
    'atribuicao_id', v_pendente.id,
    'corretor_id', v_corretor.id,
    'corretor_nome', v_corretor.nome,
    'corretor_whatsapp', v_corretor.whatsapp,
    'prazo_em', v_pendente.prazo_em,
    'motivo', v_motivo,
    'aviso_pendente', v_pendente.aviso_pendente,
    'avisar_em', case when v_pendente.aviso_pendente then interno.fim_da_pausa(now()) end
  );
end;
$function$;

-- Leads em espera e fila do plantão: quem está no bolsão fica lá.
do $$
declare v_def text;
begin
  select pg_get_functiondef('interno.oferecer_leads_em_espera'::regproc) into v_def;
  v_def := replace(v_def, $a$    where l.status = 'aguardando_corretor'
      and l.whatsapp not like 'sim-%'$a$, $a$    where l.status = 'aguardando_corretor'
      and l.bolsao_desde is null
      and l.whatsapp not like 'sim-%'$a$);
  if v_def not like '%l.bolsao_desde is null%' then raise exception 'oferecer_leads_em_espera: trecho não encontrado'; end if;
  execute v_def;

  select pg_get_functiondef('interno.oferecer_fila_ao_plantao'::regproc) into v_def;
  v_def := replace(v_def, $a$    where l.status = 'aguardando_corretor'
      and l.whatsapp not like 'sim-%'$a$, $a$    where l.status = 'aguardando_corretor'
      and l.bolsao_desde is null
      and l.whatsapp not like 'sim-%'$a$);
  if v_def not like '%l.bolsao_desde is null%' then raise exception 'oferecer_fila_ao_plantao: trecho não encontrado'; end if;
  execute v_def;

  select pg_get_functiondef('interno.registrar_prazo_perdido'::regproc) into v_def;
  v_def := replace(v_def, $a$    when 'sem_corretor_disponivel' then$a$,
    $a$    when 'bolsao' then 'Ninguém do rodízio assumiu; o lead foi para o bolsão.'
    when 'sem_corretor_disponivel' then$a$);
  if v_def not like '%foi para o bolsão%' then raise exception 'registrar_prazo_perdido: trecho não encontrado'; end if;
  execute v_def;
end $$;

-- Lista do bolsão: o essencial para decidir, sem telefone nem conversa.
create or replace function public.leads_do_bolsao()
 returns table (id uuid, nome text, resumo text, interesse text, temperatura text, regiao text, orcamento numeric,
                imovel_codigo text, imovel_referencia text, imovel_bairro text, bolsao_desde timestamptz)
 language sql
 stable security definer
 set search_path to ''
as $$
  select l.id, l.nome, l.resumo, l.interesse::text, l.temperatura::text, l.ficha ->> 'regiao',
    nullif(l.ficha ->> 'orcamento_max', '')::numeric, l.imovel_codigo, i.referencia, i.bairro, l.bolsao_desde
  from public.leads l
  left join public.imoveis i on i.codigo = l.imovel_codigo
  where l.status = 'aguardando_corretor' and l.bolsao_desde is not null
    and interno.meu_corretor_id() is not null
  order by l.bolsao_desde;
$$;
revoke all on function public.leads_do_bolsao() from public, anon;
grant execute on function public.leads_do_bolsao() to authenticated;

-- Assumir do bolsão: uma única atualização condicional, só o primeiro consegue.
create or replace function public.assumir_do_bolsao(p_lead_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu public.corretores;
  v_lead public.leads;
  v_resposta integer := coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_resposta_minutos'), 5);
begin
  select * into v_eu from public.corretores where id = interno.meu_corretor_id();
  if v_eu.id is null or v_eu.papel::text = 'administrativo' then
    raise exception 'Só corretores assumem leads do bolsão';
  end if;
  update public.leads
  set corretor_id = v_eu.id, status = 'com_corretor', ia_ativa = false
  where id = p_lead_id and status = 'aguardando_corretor' and bolsao_desde is not null
  returning * into v_lead;
  if v_lead.id is null then
    raise exception 'Este lead já foi assumido por outro corretor';
  end if;
  update public.atribuicoes set status = 'cancelada', respondida_em = now() where lead_id = p_lead_id and status = 'pendente';
  insert into public.atribuicoes (lead_id, corretor_id, prazo_em, motivo, status, respondida_em, prazo_resposta_em)
  values (p_lead_id, v_eu.id, now(), 'bolsao', 'aceita', now(), now() + make_interval(mins => v_resposta));
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', format('%s assumiu o lead do bolsão em %s', v_eu.nome,
    to_char(now() at time zone interno.fuso(), 'DD/MM/YYYY "às" HH24:MI')));
  return jsonb_build_object('ok', true, 'lead_id', p_lead_id);
end;
$$;
revoke all on function public.assumir_do_bolsao(uuid) from public, anon;
grant execute on function public.assumir_do_bolsao(uuid) to authenticated;

-- Reatribuir (do bolsão ou já assumido): gestor e administrativo.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.passar_lead'::regproc) into v_def;
  v_def := replace(v_def, $a$  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor pode passar o lead para outro corretor';$a$,
    $a$  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo passam o lead para outro corretor';$a$);
  v_def := replace(v_def, $a$  where lead_id = p_lead_id and status = 'pendente';
$a$, $a$  where lead_id = p_lead_id and status = 'pendente';
  update public.leads set bolsao_desde = null where id = p_lead_id;
$a$);
  if v_def not like '%Só o gestor ou o administrativo passam o lead%' or v_def not like '%set bolsao_desde = null%' then raise exception 'passar_lead: trecho não encontrado'; end if;
  execute v_def;
end $$;
