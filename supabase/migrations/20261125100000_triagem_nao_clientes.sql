-- Triagem: cliente x empresa/prestador x outros.
--   * leads.categoria: 'cliente', 'empresa' (vende produto ou serviço) ou
--     'outros' (vaga, corretor parceiro, engano, spam). Vazio = ainda não classificado.
--   * Só cliente vai ao rodízio: oferecer_lead recusa empresa e outros.
--   * A Thais classifica (ia_classificar_contato). Empresa e outros vão para a
--     lista "Não clientes" (gestor e administrativo): atendimento encerrado,
--     fora do rodízio e do bolsão. Se escreverem de novo, a Thais responde
--     curto e o lead continua fora do rodízio.
--   * O corretor marca "Não é cliente" (marcar_nao_cliente): o lead vai para a
--     lista e, se veio do rodízio, a vez volta para ele (a oferta deixa de contar
--     na fila). Fica registrado quem marcou e quando.
--   * O gestor reclassifica como cliente (reclassificar_como_cliente): o lead
--     volta ao fluxo normal e é oferecido ao rodízio.

alter table public.leads add column if not exists categoria text
  check (categoria is null or categoria in ('cliente', 'empresa', 'outros'));
alter table public.leads add column if not exists categoria_motivo text check (categoria_motivo is null or length(categoria_motivo) <= 300);
alter table public.leads add column if not exists categoria_por uuid references public.corretores (id) on delete set null;
alter table public.leads add column if not exists categoria_em timestamptz;
comment on column public.leads.categoria is 'Triagem: cliente, empresa (vende produto/serviço) ou outros. Só cliente vai ao rodízio.';
comment on column public.leads.categoria_por is 'Quem marcou (corretor ou gestor). Vazio quando foi a Thais.';
create index if not exists leads_nao_clientes on public.leads (categoria_em desc) where categoria in ('empresa', 'outros');

alter table public.atribuicoes add column if not exists devolvida boolean not null default false;
comment on column public.atribuicoes.devolvida is 'Oferta do rodízio de um contato que não era cliente: não conta como vez do corretor.';

create or replace function interno.eh_nao_cliente(p_categoria text)
 returns boolean language sql immutable set search_path to ''
as $$ select coalesce(p_categoria in ('empresa', 'outros'), false); $$;

-- A fila do rodízio ignora as vezes devolvidas.
create or replace function interno.fila_do_rodizio(p_lead_id uuid default null::uuid)
 returns table(corretor_id uuid, posicao integer, ultimo_lead timestamp with time zone, recebidos_hoje integer)
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_cfg jsonb := coalesce((select c.valor from public.configuracoes c where c.chave = 'rodizio'), '{}'::jsonb);
  v_regra text := coalesce(v_cfg ->> 'regra', 'mais_tempo');
  v_fim boolean := coalesce((v_cfg ->> 'perder_prazo_vai_para_fim')::boolean, true);
  v_inicio_dia timestamptz := date_trunc('day', now() at time zone interno.fuso()) at time zone interno.fuso();
begin
  return query
  with vezes as (
    select a.corretor_id, a.oferecida_em
    from public.atribuicoes a
    where a.motivo = 'rodizio' and not a.devolvida and (v_fim or a.status in ('pendente', 'aceita'))
  ),
  ultima_vez as (
    select c.ordem_rodizio from vezes v join public.corretores c on c.id = v.corretor_id
    order by v.oferecida_em desc limit 1
  ),
  candidatos as (
    select c.id, c.ordem_rodizio, c.nome,
      (select max(v.oferecida_em) from vezes v where v.corretor_id = c.id) as ultimo,
      (select count(*) from vezes v where v.corretor_id = c.id and v.oferecida_em >= v_inicio_dia)::integer as hoje
    from public.corretores c
    where c.ativo and c.no_rodizio and interno.entra_no_rodizio_agora(c.de_plantao)
      and (p_lead_id is null or not exists (
        select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.corretor_id = c.id
      ))
  )
  select k.id,
    (row_number() over (order by
      case when v_regra = 'ordem_fixa' then
        case when (select u.ordem_rodizio from ultima_vez u) is null then 0
             when coalesce(k.ordem_rodizio, 2147483647) > (select u.ordem_rodizio from ultima_vez u) then 0
             else 1 end
      end,
      case when v_regra = 'menos_hoje' then k.hoje end,
      case when v_regra <> 'ordem_fixa' then k.ultimo end asc nulls first,
      k.ordem_rodizio asc nulls last,
      k.nome))::integer,
    k.ultimo, k.hoje
  from candidatos k
  order by 2;
end;
$function$;

-- Não cliente nunca é oferecido: a trava fica no começo do oferecer_lead.
do $$
declare
  v_def text := pg_get_functiondef('public.oferecer_lead(uuid)'::regprocedure);
  v_trava text := E'  if interno.eh_nao_cliente(v_lead.categoria) then\n    return jsonb_build_object(''situacao'', ''nao_cliente'');\n  end if;\n\n  if v_lead.status = ''com_corretor'' then';
begin
  if position('eh_nao_cliente' in v_def) = 0 then
    v_def := replace(v_def, E'  if v_lead.status = ''com_corretor'' then', v_trava);
    if position('eh_nao_cliente' in v_def) = 0 then
      raise exception 'oferecer_lead mudou: não achei onde pôr a trava de não cliente';
    end if;
    execute v_def;
  end if;
end;
$$;

-- Encerra como não cliente (sem mensagem ao cliente nem pedido de avaliação).
create or replace function interno.encerrar_como_nao_cliente(p_lead_id uuid, p_categoria text, p_motivo text, p_por uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  update public.atribuicoes set status = 'cancelada' where lead_id = p_lead_id and status = 'pendente';
  -- A vez do rodízio gasta com este contato volta para o corretor.
  update public.atribuicoes set devolvida = true where lead_id = p_lead_id and motivo = 'rodizio';
  update public.tarefas set concluida_em = now() where lead_id = p_lead_id and concluida_em is null;
  update public.leads set
    categoria = p_categoria, categoria_motivo = nullif(left(trim(coalesce(p_motivo, '')), 300), ''),
    categoria_por = p_por, categoria_em = now(),
    status = 'encerrado', motivo_perda = 'Não é cliente', corretor_id = null, etapa = null,
    bolsao_desde = null, followup_etapa = 0, followup_proximo = null
  where id = p_lead_id;
end;
$$;

-- Thais: classifica o contato. Cliente só marca; empresa e outros encerram.
create or replace function public.ia_classificar_contato(p_lead_id uuid, p_categoria text, p_motivo text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_lead public.leads;
begin
  if p_categoria not in ('cliente', 'empresa', 'outros') then
    raise exception 'Categoria inválida: use cliente, empresa ou outros';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'Lead não encontrado';
  end if;
  -- Corretor ou gestor já decidiram: a Thais não muda.
  if v_lead.categoria_por is not null then
    return jsonb_build_object('categoria', v_lead.categoria, 'mantida', true);
  end if;
  if p_categoria = 'cliente' then
    update public.leads set categoria = 'cliente', categoria_motivo = nullif(left(trim(coalesce(p_motivo, '')), 300), ''), categoria_em = now()
    where id = p_lead_id;
    return jsonb_build_object('categoria', 'cliente');
  end if;
  if v_lead.status = 'com_corretor' then
    -- Lead já com corretor: quem decide é ele (botão "Não é cliente").
    return jsonb_build_object('categoria', v_lead.categoria, 'mantida', true, 'motivo', 'já está com um corretor');
  end if;
  perform interno.encerrar_como_nao_cliente(p_lead_id, p_categoria, p_motivo, null);
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', 'Triagem da Thais: não é cliente (' || case p_categoria when 'empresa' then 'empresa ou prestador' else 'outros' end || ')'
    || coalesce(': ' || nullif(trim(p_motivo), ''), '') || '. Foi para a lista Não clientes, fora do rodízio.');
  return jsonb_build_object('categoria', p_categoria, 'lista', 'nao_clientes');
end;
$$;
revoke all on function public.ia_classificar_contato(uuid, text, text) from public, anon, authenticated;

-- Corretor (do lead) ou gestão: "Não é cliente".
create or replace function public.marcar_nao_cliente(p_lead_id uuid, p_categoria text default 'outros', p_motivo text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_lead public.leads;
  v_eu uuid := interno.meu_corretor_id();
  v_nome text;
begin
  if p_categoria not in ('empresa', 'outros') then
    raise exception 'Escolha empresa/prestador ou outros';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null or not interno.posso_ver_lead(p_lead_id) then
    raise exception 'Lead não encontrado';
  end if;
  if not interno.sou_gestor() and (v_lead.corretor_id is distinct from v_eu)
     and not exists (select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.corretor_id = v_eu and a.status = 'pendente') then
    raise exception 'Só o corretor do lead ou a gestão marcam como não cliente';
  end if;
  perform interno.encerrar_como_nao_cliente(p_lead_id, p_categoria, p_motivo, v_eu);
  select nome into v_nome from public.corretores where id = v_eu;
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', 'Marcado como não cliente (' || case p_categoria when 'empresa' then 'empresa ou prestador' else 'outros' end
    || ') por ' || coalesce(v_nome, 'alguém da equipe') || coalesce(': ' || nullif(trim(p_motivo), ''), '') || '. A vez no rodízio foi devolvida.');
end;
$$;
revoke all on function public.marcar_nao_cliente(uuid, text, text) from public, anon;
grant execute on function public.marcar_nao_cliente(uuid, text, text) to authenticated;

-- Gestor: era cliente, sim. Volta ao fluxo normal (rodízio).
create or replace function public.reclassificar_como_cliente(p_lead_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_lead public.leads;
  v_eu uuid := interno.meu_corretor_id();
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor reclassifica como cliente';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null or not interno.eh_nao_cliente(v_lead.categoria) then
    raise exception 'Este contato não está na lista Não clientes';
  end if;
  update public.leads set
    categoria = 'cliente', categoria_por = v_eu, categoria_em = now(), categoria_motivo = 'Reclassificado pelo gestor',
    status = 'em_atendimento_ia', motivo_perda = null, ia_ativa = false, excluido_em = null, excluido_por = null
  where id = p_lead_id;
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', 'O gestor reclassificou como cliente. O lead voltou para o rodízio.');
  return public.oferecer_lead(p_lead_id);
end;
$$;
revoke all on function public.reclassificar_como_cliente(uuid) from public, anon;
grant execute on function public.reclassificar_como_cliente(uuid) to authenticated;

-- Lista "Não clientes" (gestor e administrativo; o administrativo não abre leads).
create or replace function public.nao_clientes()
 returns table (id uuid, nome text, whatsapp text, categoria text, motivo text, marcado_por text, marcado_em timestamptz,
   ultima_mensagem text, ultima_mensagem_em timestamptz, origem text, campanha text)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só gestor e administrativo veem os não clientes';
  end if;
  return query
    select l.id, l.nome, l.whatsapp, l.categoria, l.categoria_motivo,
      coalesce(c.nome, 'Thais (triagem)'), l.categoria_em, l.ultima_mensagem, l.ultima_mensagem_em, l.origem, l.campanha
    from public.leads l
    left join public.corretores c on c.id = l.categoria_por
    where interno.eh_nao_cliente(l.categoria) and l.excluido_em is null
    order by l.categoria_em desc nulls last
    limit 500;
end;
$$;
revoke all on function public.nao_clientes() from public, anon;
grant execute on function public.nao_clientes() to authenticated;

-- Quem não é cliente e escreve de novo não reabre: segue fora do rodízio e a
-- Thais responde curto (ela vê a categoria no contexto).
create or replace function interno.reabrir_ao_escrever()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_lead public.leads;
begin
  select * into v_lead from public.leads where id = new.lead_id and status = 'encerrado' for update;
  if not found then
    return null;
  end if;
  if interno.eh_nao_cliente(v_lead.categoria) then
    update public.leads set ia_ativa = true where id = v_lead.id and not ia_ativa;
    return null;
  end if;
  if exists (select 1 from public.corretores c where c.id = v_lead.corretor_id and c.ativo) then
    update public.leads set status = 'com_corretor', etapa = 'a_contatar', motivo_perda = null, valor_negocio = null, excluido_em = null, excluido_por = null
    where id = v_lead.id;
    insert into public.mensagens (lead_id, autor, conteudo)
    values (v_lead.id, 'sistema', 'O cliente voltou a escrever e a negociação foi reaberta');
  else
    update public.leads
    set status = 'em_atendimento_ia', etapa = null, corretor_id = null, ia_ativa = true, motivo_perda = null, valor_negocio = null, excluido_em = null, excluido_por = null
    where id = v_lead.id;
    insert into public.mensagens (lead_id, autor, conteudo)
    values (v_lead.id, 'sistema', 'O cliente voltou a escrever e a assistente retomou o atendimento');
  end if;
  return null;
end;
$function$;

-- "Não é cliente" nunca recebe o pedido de avaliação.
update public.configuracoes
set valor = jsonb_set(valor, '{motivos_sem_avaliacao}',
  (select jsonb_agg(distinct m) from jsonb_array_elements_text(
     coalesce(valor -> 'motivos_sem_avaliacao', '[]'::jsonb) || '["Não é cliente"]'::jsonb) m))
where chave = 'avaliacao';
