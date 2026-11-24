-- Funções usadas pelo agente de IA (busca e consulta de imóveis, ficha do lead)
-- e o rodízio de corretores com prazo para assumir.
-- As funções ia_* e oferecer_lead só podem ser chamadas pelo servidor
-- (service role); assumir_lead é chamada pelo corretor logado no painel.

create extension if not exists unaccent with schema extensions;

-- Utilitários ------------------------------------------------------------------

create function interno.sem_acento(p text) returns text
language sql stable set search_path = ''
as $$ select lower(extensions.unaccent(coalesce(p, ''))) $$;

create function interno.distancia_km(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language sql immutable set search_path = ''
as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  ))
$$;

-- Preço que vale para a finalidade pedida; promoção maior que zero tem prioridade na venda.
create function interno.preco_imovel(i public.imoveis, p_finalidade text) returns numeric
language sql immutable set search_path = ''
as $$
  select case when p_finalidade = 'locacao' then i.valor_locacao
              else coalesce(nullif(i.valor_promocional, 0), i.valor_venda) end
$$;

-- Confere no XML do Univen, na hora, se o imóvel continua ativo.
-- true = ativo; false = não está no XML; null = não foi possível verificar.
create function interno.ativo_no_univen(p_codigo text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_resposta extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '20');
  v_resposta := extensions.http_get('https://integracaounion.com.br/union/42115/42115.xml');
  -- Só confia num documento completo e com imóveis; o resto é "não deu para verificar".
  if v_resposta.status <> 200
     or strpos(v_resposta.content, '</Union>') = 0
     or strpos(v_resposta.content, '<Imovel>') = 0 then
    return null;
  end if;
  return strpos(v_resposta.content, '<Codigoimovel>' || p_codigo || '</Codigoimovel>') > 0;
exception when others then
  return null;
end;
$$;

-- Busca de imóveis -------------------------------------------------------------

-- Imóveis ativos que combinam com o pedido. Com região, traz o bairro (ou a
-- cidade) pedido e a vizinhança num raio de 2,5 km; com orçamento, aceita até
-- 15% acima e marca esses casos.
create function public.ia_buscar_imoveis(
  p_finalidade text,
  p_tipo text default null,
  p_regiao text default null,
  p_valor_max numeric default null,
  p_valor_min numeric default null,
  p_dormitorios_min integer default null,
  p_aceita_pet boolean default null,
  p_limite integer default 5
) returns table (
  codigo text,
  referencia text,
  tipo text,
  bairro text,
  cidade text,
  valor numeric,
  condominio numeric,
  dormitorios integer,
  suites integer,
  vagas integer,
  area_construida numeric,
  area_terreno numeric,
  aceita_financiamento smallint,
  aceita_pet boolean,
  link_site text,
  foto_principal text,
  distancia_km numeric,
  na_regiao boolean,
  acima_do_orcamento boolean
)
language sql stable security definer set search_path = ''
as $$
  with centro as (
    select avg(i.latitude) as lat, avg(i.longitude) as lon
    from public.imoveis i
    where p_regiao is not null
      and i.latitude is not null
      and (interno.sem_acento(i.bairro) like '%' || interno.sem_acento(p_regiao) || '%'
           or interno.sem_acento(i.cidade) = interno.sem_acento(p_regiao))
  ),
  candidatos as (
    select
      i.*,
      interno.preco_imovel(i, p_finalidade) as preco,
      p_regiao is not null
        and (interno.sem_acento(i.bairro) like '%' || interno.sem_acento(p_regiao) || '%'
             or interno.sem_acento(i.cidade) = interno.sem_acento(p_regiao)) as no_lugar,
      case when c.lat is not null and i.latitude is not null
           then interno.distancia_km(c.lat, c.lon, i.latitude, i.longitude) end as km
    from public.imoveis i
    cross join centro c
    where i.ativo
      and case when p_finalidade = 'locacao' then i.locacao else i.venda end
      and (p_tipo is null or i.tipo = upper(p_tipo))
      and (p_dormitorios_min is null or coalesce(i.dormitorios, 0) >= p_dormitorios_min)
      and (p_aceita_pet is not true or i.aceita_pet is distinct from false)
  )
  select
    codigo, referencia, tipo, bairro, cidade, preco, valor_condominio,
    dormitorios, suites, vagas, area_construida, area_terreno,
    aceita_financiamento, aceita_pet, link_site, foto_principal,
    round(km::numeric, 1), no_lugar,
    p_valor_max is not null and preco > p_valor_max
  from candidatos
  where preco > 0
    and (p_valor_max is null or preco <= p_valor_max * 1.15)
    and (p_valor_min is null or preco >= p_valor_min)
    and (p_regiao is null or no_lugar or km <= 2.5)
  order by
    no_lugar desc,
    p_valor_max is not null and preco > p_valor_max,
    km nulls last,
    abs(preco - coalesce(p_valor_max, preco))
  limit least(greatest(coalesce(p_limite, 5), 1), 10);
$$;

-- Consulta de um imóvel pela referência (CA00742), pelo código do Univen ou
-- pelo link do site, já conferindo na hora se ele continua ativo no Univen.
create function public.ia_consultar_imovel(p_busca text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_chave text := upper(trim(coalesce(p_busca, '')));
  v_codigo_link text := substring(trim(coalesce(p_busca, '')) from '([0-9]{6,})/?$');
  v_imovel public.imoveis;
  v_ativo boolean;
begin
  select * into v_imovel from public.imoveis
  where referencia = v_chave or codigo = v_chave or codigo = v_codigo_link
  limit 1;

  -- Imóvel cadastrado depois da última sincronização: sincroniza e tenta de novo,
  -- no máximo uma vez a cada 2 minutos.
  if not found and not exists (
    select 1 from public.sincronizacoes where iniciada_em > now() - interval '2 minutes'
  ) then
    perform interno.sincronizar_imoveis();
    select * into v_imovel from public.imoveis
    where referencia = v_chave or codigo = v_chave or codigo = v_codigo_link
    limit 1;
  end if;

  if v_imovel.codigo is null then
    return jsonb_build_object('encontrado', false);
  end if;

  v_ativo := interno.ativo_no_univen(v_imovel.codigo);
  if v_ativo is false and v_imovel.ativo then
    update public.imoveis set ativo = false, inativado_em = now() where codigo = v_imovel.codigo;
  end if;

  -- O número do endereço fica de fora: o corretor passa na hora da visita.
  return jsonb_build_object(
    'encontrado', true,
    'disponivel', v_ativo,
    'codigo', v_imovel.codigo,
    'referencia', v_imovel.referencia,
    'tipo', v_imovel.tipo,
    'categoria', v_imovel.categoria,
    'finalidade', v_imovel.finalidade,
    'a_venda', v_imovel.venda,
    'para_alugar', v_imovel.locacao,
    'valor_venda', v_imovel.valor_venda,
    'valor_promocional', nullif(v_imovel.valor_promocional, 0),
    'valor_aluguel', v_imovel.valor_locacao,
    'condominio', v_imovel.valor_condominio,
    'iptu', v_imovel.valor_iptu,
    'dormitorios', v_imovel.dormitorios,
    'suites', v_imovel.suites,
    'banheiros', v_imovel.banheiros,
    'vagas', v_imovel.vagas,
    'area_construida_m2', v_imovel.area_construida,
    'area_terreno_m2', v_imovel.area_terreno,
    'area_util_m2', v_imovel.area_util,
    'rua', v_imovel.endereco,
    'bairro', v_imovel.bairro,
    'cidade', v_imovel.cidade,
    'uf', v_imovel.uf,
    'aceita_financiamento', v_imovel.aceita_financiamento,
    'aceita_pet', v_imovel.aceita_pet,
    'mobiliado', v_imovel.mobiliado,
    'link_site', v_imovel.link_site,
    'foto_principal', v_imovel.foto_principal,
    'total_fotos', cardinality(v_imovel.fotos),
    'caracteristicas', v_imovel.caracteristicas,
    'descricao', left(v_imovel.descricao, 1500)
  );
end;
$$;

-- Ficha do lead ----------------------------------------------------------------

create function public.ia_atualizar_lead(
  p_lead_id uuid,
  p_ficha jsonb default '{}',
  p_nome text default null,
  p_interesse public.lead_interesse default null,
  p_temperatura public.lead_temperatura default null,
  p_resumo text default null,
  p_imovel text default null
) returns public.leads
language sql security definer set search_path = ''
as $$
  update public.leads set
    ficha = ficha || jsonb_strip_nulls(coalesce(p_ficha, '{}')),
    nome = coalesce(p_nome, nome),
    interesse = coalesce(p_interesse, interesse),
    temperatura = coalesce(p_temperatura, temperatura),
    resumo = coalesce(p_resumo, resumo),
    imovel_codigo = coalesce(
      (select i.codigo from public.imoveis i
       where i.codigo = p_imovel or i.referencia = upper(p_imovel) limit 1),
      imovel_codigo
    )
  where id = p_lead_id
  returning *;
$$;

-- Rodízio ----------------------------------------------------------------------

-- Oferece o lead ao próximo corretor de plantão que ainda não o recebeu: quem
-- está há mais tempo sem receber lead vem primeiro.
create function public.oferecer_lead(p_lead_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_pendente public.atribuicoes;
  v_corretor public.corretores;
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
      'prazo_em', v_pendente.prazo_em
    );
  end if;

  update public.leads set status = 'aguardando_corretor' where id = p_lead_id;

  select c.* into v_corretor
  from public.corretores c
  where c.ativo and c.no_rodizio and c.de_plantao
    and not exists (
      select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.corretor_id = c.id
    )
  order by
    (select max(a.oferecida_em) from public.atribuicoes a where a.corretor_id = c.id) asc nulls first,
    c.ordem_rodizio asc nulls last,
    c.nome
  limit 1;

  if v_corretor.id is null then
    return jsonb_build_object('situacao', 'sem_corretor_disponivel');
  end if;

  select (valor #>> '{}')::integer into v_prazo_minutos
  from public.configuracoes where chave = 'prazo_rodizio_minutos';

  insert into public.atribuicoes (lead_id, corretor_id, prazo_em)
  values (p_lead_id, v_corretor.id, now() + make_interval(mins => coalesce(v_prazo_minutos, 5)))
  returning * into v_pendente;

  return jsonb_build_object(
    'situacao', 'oferecido',
    'atribuicao_id', v_pendente.id,
    'corretor_id', v_corretor.id,
    'corretor_nome', v_corretor.nome,
    'corretor_whatsapp', v_corretor.whatsapp,
    'prazo_em', v_pendente.prazo_em
  );
end;
$$;

-- Corretor aceita o lead: a IA pausa e o lead passa a ser dele.
create function interno.aceitar_atribuicao(p_atribuicao_id uuid, p_corretor_id uuid)
returns public.leads
language plpgsql security definer set search_path = ''
as $$
declare
  v_atribuicao public.atribuicoes;
  v_lead public.leads;
begin
  select * into v_atribuicao from public.atribuicoes where id = p_atribuicao_id for update;
  if not found or v_atribuicao.corretor_id is distinct from p_corretor_id then
    raise exception 'Atribuição não encontrada para este corretor';
  end if;
  if v_atribuicao.status <> 'pendente' then
    raise exception 'Este lead já não está disponível para você (situação: %)', v_atribuicao.status;
  end if;

  update public.atribuicoes set status = 'aceita', respondida_em = now() where id = p_atribuicao_id;
  update public.leads
  set corretor_id = p_corretor_id, status = 'com_corretor', ia_ativa = false
  where id = v_atribuicao.lead_id
  returning * into v_lead;
  return v_lead;
end;
$$;

create function public.assumir_lead(p_atribuicao_id uuid) returns public.leads
language sql security definer set search_path = ''
as $$ select interno.aceitar_atribuicao(p_atribuicao_id, interno.meu_corretor_id()) $$;

-- Prazo vencido: a atribuição expira e o lead vai ao próximo corretor.
create function interno.processar_prazos_rodizio() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_expirada record;
  v_total integer := 0;
begin
  for v_expirada in
    update public.atribuicoes set status = 'expirada'
    where status = 'pendente' and prazo_em < now()
    returning lead_id
  loop
    perform public.oferecer_lead(v_expirada.lead_id);
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$;

select cron.schedule('prazos-rodizio', '* * * * *', $$select interno.processar_prazos_rodizio()$$);

-- Chaves de acesso das ferramentas internas (ex.: simulador de conversa).
-- Guarda só o hash; sem regras de acesso, apenas o servidor lê.
create table public.chaves_acesso (
  nome text primary key,
  hash_sha256 text not null,
  criada_em timestamptz not null default now()
);
alter table public.chaves_acesso enable row level security;

-- Permissões -------------------------------------------------------------------

revoke execute on function public.ia_buscar_imoveis(text, text, text, numeric, numeric, integer, boolean, integer) from public, anon, authenticated;
revoke execute on function public.ia_consultar_imovel(text) from public, anon, authenticated;
revoke execute on function public.ia_atualizar_lead(uuid, jsonb, text, public.lead_interesse, public.lead_temperatura, text, text) from public, anon, authenticated;
revoke execute on function public.oferecer_lead(uuid) from public, anon, authenticated;
revoke execute on function public.assumir_lead(uuid) from public, anon;

grant execute on function public.ia_buscar_imoveis(text, text, text, numeric, numeric, integer, boolean, integer) to service_role;
grant execute on function public.ia_consultar_imovel(text) to service_role;
grant execute on function public.ia_atualizar_lead(uuid, jsonb, text, public.lead_interesse, public.lead_temperatura, text, text) to service_role;
grant execute on function public.oferecer_lead(uuid) to service_role;
grant execute on function public.assumir_lead(uuid) to authenticated;
