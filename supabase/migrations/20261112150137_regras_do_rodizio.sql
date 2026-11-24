-- Regras do rodízio, configuráveis pelo gestor, e a fila que todos veem.
-- Regra fixa: lead de imóvel vai primeiro ao captador do imóvel (oferecer_lead).
-- Depois, o rodízio entre quem está de plantão segue a regra escolhida:
--   mais_tempo  vez de quem está há mais tempo sem receber (padrão)
--   ordem_fixa  sequência definida pelo gestor, girando
--   menos_hoje  quem recebeu menos leads do rodízio hoje
-- perder_prazo_vai_para_fim: oferta que venceu ou foi recusada conta como vez.

insert into public.configuracoes (chave, valor)
values ('rodizio', '{"regra": "mais_tempo", "perder_prazo_vai_para_fim": true}'::jsonb)
on conflict (chave) do nothing;

-- Ordem inicial da equipe (alfabética) para a ordem fixa e os desempates.
update public.corretores c set ordem_rodizio = o.n
from (select id, row_number() over (order by nome) as n from public.corretores) o
where o.id = c.id and c.ordem_rodizio is null;

create function interno.fila_do_rodizio(p_lead_id uuid default null)
returns table (corretor_id uuid, posicao integer, ultimo_lead timestamptz, recebidos_hoje integer)
language plpgsql stable security definer set search_path = ''
as $$
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
    where a.motivo = 'rodizio' and (v_fim or a.status in ('pendente', 'aceita'))
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
    where c.ativo and c.no_rodizio and c.de_plantao
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
$$;

-- Distribuição: captador do imóvel primeiro (sempre); depois, o primeiro da fila.
create or replace function public.oferecer_lead(p_lead_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_lead public.leads;
  v_pendente public.atribuicoes;
  v_corretor public.corretores;
  v_motivo public.atribuicao_motivo := 'rodizio';
  v_prazo_minutos integer;
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

  update public.leads set status = 'aguardando_corretor' where id = p_lead_id;

  -- Regra principal: o captador do imóvel de interesse recebe primeiro.
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

  -- Depois, o rodízio, pela regra escolhida pelo gestor.
  if v_corretor.id is null then
    select c.* into v_corretor
    from interno.fila_do_rodizio(p_lead_id) f
    join public.corretores c on c.id = f.corretor_id
    order by f.posicao
    limit 1;
  end if;

  if v_corretor.id is null then
    return jsonb_build_object('situacao', 'sem_corretor_disponivel');
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
    'motivo', v_motivo
  );
end;
$function$;

-- Para o painel: a fila como está agora, com quem tem oferta aberta.
create function public.fila_do_rodizio()
returns table (corretor_id uuid, posicao integer, ultimo_lead timestamptz, recebidos_hoje integer, oferta_ate timestamptz)
language sql stable security definer set search_path = ''
as $$
  select f.corretor_id, f.posicao, f.ultimo_lead, f.recebidos_hoje,
    (select min(a.prazo_em) from public.atribuicoes a where a.corretor_id = f.corretor_id and a.status = 'pendente')
  from interno.fila_do_rodizio(null) f
  where interno.meu_corretor_id() is not null
  order by f.posicao;
$$;

-- Regras atuais, para todos verem (só leitura).
create function public.regras_do_rodizio()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when interno.meu_corretor_id() is null then null else
    coalesce((select c.valor from public.configuracoes c where c.chave = 'rodizio'), '{}'::jsonb)
    || jsonb_build_object('prazo_minutos', coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 5))
  end;
$$;

-- Só o gestor muda a regra e a ordem da equipe.
create function public.salvar_regras_rodizio(p_regra text, p_perder_prazo_vai_para_fim boolean, p_ordem uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_valor jsonb;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor muda as regras do rodízio';
  end if;
  if p_regra not in ('mais_tempo', 'ordem_fixa', 'menos_hoje') then
    raise exception 'Regra do rodízio inválida';
  end if;
  v_valor := jsonb_build_object('regra', p_regra, 'perder_prazo_vai_para_fim', coalesce(p_perder_prazo_vai_para_fim, true));
  insert into public.configuracoes (chave, valor) values ('rodizio', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  if p_ordem is not null then
    update public.corretores c set ordem_rodizio = o.n
    from unnest(p_ordem) with ordinality as o(id, n)
    where c.id = o.id;
  end if;
  return v_valor;
end;
$$;

revoke all on function interno.fila_do_rodizio(uuid) from public, anon, authenticated;
revoke all on function public.fila_do_rodizio(), public.regras_do_rodizio(), public.salvar_regras_rodizio(text, boolean, uuid[]) from public, anon;
grant execute on function public.fila_do_rodizio(), public.regras_do_rodizio(), public.salvar_regras_rodizio(text, boolean, uuid[]) to authenticated;
