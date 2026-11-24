-- Empreendimentos e banners do site:
--   * empreendimentos: cadastro feito no painel por gestor e administrativo
--     (salvar_empreendimento / apagar_empreendimento). Fotos e plantas ficam no
--     bucket público "site", na pasta empreendimentos/.
--   * banners_site: carrossel da página inicial, editado pelo gestor na tela Site
--     (salvar_banners troca a lista inteira, na ordem recebida).
--   * site_dados passa a mandar os empreendimentos e os banners ativos ao gerador.
--   * pedir_informacoes_site: formulário "Quero receber mais informações" da
--     página do empreendimento (chamado pelo site, sem login). O lead entra com a
--     origem "site", a campanha "Site – Empreendimento <nome>" e segue o rodízio.
--     Limites contra robôs: 3 pedidos por telefone por dia, 5 por visitante por
--     hora e 60 no total por hora.

create table if not exists public.empreendimentos (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  nome text not null check (length(trim(nome)) between 2 and 80),
  construtora text check (construtora is null or length(construtora) <= 80),
  tipo text not null default 'loteamento' check (tipo in ('loteamento', 'apartamento', 'casa_condominio', 'comercial', 'outro')),
  status text not null default 'lancamento' check (status in ('lancamento', 'breve_lancamento', 'em_obras', 'pronto', 'ultimas_unidades')),
  bairro text check (bairro is null or length(bairro) <= 80),
  endereco text check (endereco is null or length(endereco) <= 200),
  cidade text not null default 'Campo Grande' check (length(cidade) <= 80),
  uf text not null default 'MS' check (uf ~ '^[A-Z]{2}$'),
  previsao_entrega text check (previsao_entrega is null or length(previsao_entrega) <= 80),
  metragens text check (metragens is null or length(metragens) <= 120),
  preco_a_partir numeric check (preco_a_partir is null or preco_a_partir > 0),
  resumo text check (resumo is null or length(resumo) <= 220),
  descricao text check (descricao is null or length(descricao) <= 8000),
  lazer text[] not null default '{}',
  diferenciais text[] not null default '{}',
  fotos text[] not null default '{}',
  plantas text[] not null default '{}',
  video_url text check (video_url is null or video_url ~ '^https://'),
  latitude numeric check (latitude is null or latitude between -90 and 90),
  longitude numeric check (longitude is null or longitude between -180 and 180),
  link_oficial text check (link_oficial is null or link_oficial ~ '^https://'),
  campanha_ia_id uuid references public.campanhas_ia (id) on delete set null,
  ativo boolean not null default true,
  ordem integer not null default 0,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.corretores (id) on delete set null
);
alter table public.empreendimentos enable row level security;
drop policy if exists "Equipe vê os empreendimentos" on public.empreendimentos;
create policy "Equipe vê os empreendimentos" on public.empreendimentos for select to authenticated using (true);

create table if not exists public.banners_site (
  id uuid primary key default gen_random_uuid(),
  ordem integer not null default 0,
  ativo boolean not null default true,
  imagem_url text not null check (imagem_url ~ '^https://'),
  imagem_celular_url text check (imagem_celular_url is null or imagem_celular_url ~ '^https://'),
  titulo text check (titulo is null or length(titulo) <= 90),
  texto text check (texto is null or length(texto) <= 200),
  botao text check (botao is null or length(botao) <= 40),
  link text check (link is null or link ~ '^(https://|/)'),
  atualizado_em timestamptz not null default now()
);
alter table public.banners_site enable row level security;
drop policy if exists "Equipe vê os banners" on public.banners_site;
create policy "Equipe vê os banners" on public.banners_site for select to authenticated using (true);

-- Pedidos do formulário do site (para limitar robôs e saber de onde veio).
create table if not exists public.pedidos_site (
  id bigint generated always as identity primary key,
  empreendimento_id uuid references public.empreendimentos (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  telefone text not null,
  visitante text,
  criado_em timestamptz not null default now()
);
alter table public.pedidos_site enable row level security;
drop policy if exists "Gestão vê os pedidos do site" on public.pedidos_site;
create policy "Gestão vê os pedidos do site" on public.pedidos_site for select to authenticated using (interno.sou_gestor());
create index if not exists pedidos_site_telefone on public.pedidos_site (telefone, criado_em);
create index if not exists pedidos_site_criado on public.pedidos_site (criado_em);

-- Fotos e plantas dos empreendimentos: gestor e administrativo enviam na pasta empreendimentos/.
drop policy if exists "Gestão envia fotos de empreendimentos" on storage.objects;
create policy "Gestão envia fotos de empreendimentos" on storage.objects for insert to authenticated
  with check (bucket_id = 'site' and name like 'empreendimentos/%' and (select interno.sou_gestor()));
drop policy if exists "Gestão troca fotos de empreendimentos" on storage.objects;
create policy "Gestão troca fotos de empreendimentos" on storage.objects for update to authenticated
  using (bucket_id = 'site' and name like 'empreendimentos/%' and (select interno.sou_gestor()));
drop policy if exists "Gestão apaga fotos de empreendimentos" on storage.objects;
create policy "Gestão apaga fotos de empreendimentos" on storage.objects for delete to authenticated
  using (bucket_id = 'site' and name like 'empreendimentos/%' and (select interno.sou_gestor()));

-- Lista de textos limpa: sem vazios, sem repetidos, até 40 itens de 120 letras.
create or replace function interno.lista_limpa(p_itens text[])
 returns text[] language sql immutable set search_path to ''
as $$
  select coalesce(array_agg(t order by n), '{}')
  from (
    select left(trim(i), 120) as t, min(n) as n
    from unnest(coalesce(p_itens, '{}')) with ordinality as x(i, n)
    where trim(coalesce(i, '')) <> ''
    group by left(trim(i), 120)
    order by min(n)
    limit 40
  ) l;
$$;

create or replace function public.salvar_empreendimento(p_id uuid, p_dados jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_id uuid;
  v_texto_lista text[];
  v_slug text := lower(trim(coalesce(p_dados ->> 'slug', '')));
  v_fotos text[];
  v_plantas text[];
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo cadastram empreendimentos';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Endereço da página inválido: use letras minúsculas, números e hífen (ex.: atmosphere)';
  end if;
  select coalesce(array_agg(u), '{}') into v_fotos from jsonb_array_elements_text(coalesce(p_dados -> 'fotos', '[]')) u where u ~ '^https://';
  select coalesce(array_agg(u), '{}') into v_plantas from jsonb_array_elements_text(coalesce(p_dados -> 'plantas', '[]')) u where u ~ '^https://';
  if cardinality(v_fotos) > 40 or cardinality(v_plantas) > 20 then
    raise exception 'Até 40 fotos e 20 plantas por empreendimento';
  end if;
  begin
    if p_id is null then
      insert into public.empreendimentos (slug, nome) values (v_slug, trim(p_dados ->> 'nome')) returning id into v_id;
    else
      v_id := p_id;
      if not exists (select 1 from public.empreendimentos where id = v_id) then
        raise exception 'Empreendimento não encontrado';
      end if;
    end if;
    update public.empreendimentos set
      slug = v_slug,
      nome = trim(p_dados ->> 'nome'),
      construtora = nullif(trim(p_dados ->> 'construtora'), ''),
      tipo = coalesce(nullif(p_dados ->> 'tipo', ''), 'loteamento'),
      status = coalesce(nullif(p_dados ->> 'status', ''), 'lancamento'),
      bairro = nullif(trim(p_dados ->> 'bairro'), ''),
      endereco = nullif(trim(p_dados ->> 'endereco'), ''),
      cidade = coalesce(nullif(trim(p_dados ->> 'cidade'), ''), 'Campo Grande'),
      uf = upper(coalesce(nullif(trim(p_dados ->> 'uf'), ''), 'MS')),
      previsao_entrega = nullif(trim(p_dados ->> 'previsao_entrega'), ''),
      metragens = nullif(trim(p_dados ->> 'metragens'), ''),
      preco_a_partir = nullif(p_dados ->> 'preco_a_partir', '')::numeric,
      resumo = nullif(trim(p_dados ->> 'resumo'), ''),
      descricao = nullif(trim(p_dados ->> 'descricao'), ''),
      lazer = interno.lista_limpa(array(select jsonb_array_elements_text(coalesce(p_dados -> 'lazer', '[]')))),
      diferenciais = interno.lista_limpa(array(select jsonb_array_elements_text(coalesce(p_dados -> 'diferenciais', '[]')))),
      fotos = v_fotos,
      plantas = v_plantas,
      video_url = nullif(trim(p_dados ->> 'video_url'), ''),
      latitude = nullif(p_dados ->> 'latitude', '')::numeric,
      longitude = nullif(p_dados ->> 'longitude', '')::numeric,
      link_oficial = nullif(trim(p_dados ->> 'link_oficial'), ''),
      campanha_ia_id = nullif(p_dados ->> 'campanha_ia_id', '')::uuid,
      ativo = coalesce((p_dados ->> 'ativo')::boolean, true),
      ordem = coalesce(nullif(p_dados ->> 'ordem', '')::integer, 0),
      atualizado_em = now(),
      atualizado_por = interno.meu_corretor_id()
    where id = v_id;
  exception
    when unique_violation then raise exception 'Já existe um empreendimento com o endereço "%"', v_slug;
    when check_violation then raise exception 'Confira os campos: nome de 2 a 80 letras, links começando com https:// e textos dentro do tamanho';
    when invalid_text_representation then raise exception 'Confira os números: preço, latitude e longitude';
  end;
  return v_id;
end;
$$;
revoke all on function public.salvar_empreendimento(uuid, jsonb) from public, anon;
grant execute on function public.salvar_empreendimento(uuid, jsonb) to authenticated;

create or replace function public.apagar_empreendimento(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo apagam empreendimentos';
  end if;
  delete from public.empreendimentos where id = p_id;
end;
$$;
revoke all on function public.apagar_empreendimento(uuid) from public, anon;
grant execute on function public.apagar_empreendimento(uuid) to authenticated;

-- Banners: o gestor manda a lista inteira, na ordem em que devem aparecer.
create or replace function public.salvar_banners(p_banners jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_item jsonb;
  v_n integer := 0;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor muda os banners do site';
  end if;
  if jsonb_typeof(p_banners) <> 'array' or jsonb_array_length(p_banners) > 12 then
    raise exception 'Até 12 banners';
  end if;
  delete from public.banners_site where true;
  for v_item in select * from jsonb_array_elements(p_banners) loop
    v_n := v_n + 1;
    begin
      insert into public.banners_site (ordem, ativo, imagem_url, imagem_celular_url, titulo, texto, botao, link)
      values (
        v_n, coalesce((v_item ->> 'ativo')::boolean, true), v_item ->> 'imagem_url',
        nullif(trim(v_item ->> 'imagem_celular_url'), ''), nullif(trim(v_item ->> 'titulo'), ''),
        nullif(trim(v_item ->> 'texto'), ''), nullif(trim(v_item ->> 'botao'), ''), nullif(trim(v_item ->> 'link'), '')
      );
    exception when check_violation or not_null_violation then
      raise exception 'Banner %: precisa de imagem; o link começa com https:// ou com /; título até 90 letras, texto até 200 e botão até 40', v_n;
    end;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.salvar_banners(jsonb) from public, anon;
grant execute on function public.salvar_banners(jsonb) to authenticated;

-- Dados públicos do site: o que já ia, mais empreendimentos e banners ativos.
create or replace function public.site_dados()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'config', (select c.valor from public.configuracoes c where c.chave = 'site'),
    'empresa', (select c.valor - 'api' from public.configuracoes c where c.chave = 'empresa'),
    'equipe', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nome', r.nome, 'papel', r.papel::text, 'creci', r.creci, 'foto_url', r.foto_url,
        'slug', case when r.papel::text <> 'administrativo' then r.slug end,
        'whatsapp', case when r.papel::text <> 'administrativo' then r.whatsapp end
      ) order by (r.papel::text = 'gestor') desc, r.nome)
      from public.corretores r
      where r.ativo
    ), '[]'::jsonb),
    'imoveis', coalesce((
      select jsonb_agg(jsonb_build_object(
        'codigo', i.codigo, 'referencia', i.referencia, 'tipo', i.tipo, 'titulo', i.titulo, 'descricao', i.descricao,
        'venda', i.venda, 'locacao', i.locacao, 'valor_venda', i.valor_venda, 'valor_locacao', i.valor_locacao,
        'valor_condominio', i.valor_condominio, 'valor_iptu', i.valor_iptu,
        'dormitorios', i.dormitorios, 'suites', i.suites, 'banheiros', i.banheiros, 'vagas', i.vagas,
        'area_construida', i.area_construida, 'area_terreno', i.area_terreno, 'area_util', i.area_util,
        'bairro', i.bairro, 'cidade', i.cidade, 'uf', i.uf, 'link_site', i.link_site,
        'foto_principal', i.foto_principal, 'foto_mini', i.foto_mini, 'fotos', to_jsonb(i.fotos),
        'aceita_financiamento', i.aceita_financiamento = 1, 'aceita_pet', i.aceita_pet, 'mobiliado', i.mobiliado,
        'origem', i.origem, 'captador', i.captador,
        'lat', round(nullif(i.latitude, 0)::numeric, 2), 'lng', round(nullif(i.longitude, 0)::numeric, 2),
        'corretor', (
          select jsonb_build_object('nome', r.nome, 'creci', r.creci, 'foto_url', r.foto_url, 'slug', r.slug)
          from public.corretores r
          where r.ativo and i.captador is not null
            and (lower(r.nome_no_univen) = lower(i.captador) or lower(r.nome) = lower(i.captador))
          order by (lower(r.nome_no_univen) = lower(i.captador)) desc nulls last
          limit 1
        ),
        'comodidades', (
          select coalesce(jsonb_agg(k.key), '[]'::jsonb)
          from jsonb_each_text(i.caracteristicas) k
          where k.value = '1' and k.key in (
            'Piscina', 'Arealazer', 'Varandagourmet', 'Gourmet', 'Portaria24horas', 'Quintal', 'Varanda', 'Arcondicionado',
            'Armariocozinha', 'Lavanderia', 'Suitemaster', 'Murado', 'Portaoeletronico', 'Alarme', 'Interforne', 'Salafesta',
            'Porcelanato', 'Copa', 'Banheiroauxiliar'
          )
        ),
        'atualizado', i.atualizado_univen
      ) order by i.atualizado_univen desc nulls last, i.codigo)
      from public.imoveis i
      where i.ativo
    ), '[]'::jsonb),
    'empreendimentos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', m.slug, 'nome', m.nome, 'construtora', m.construtora, 'tipo', m.tipo, 'status', m.status,
        'bairro', m.bairro, 'endereco', m.endereco, 'cidade', m.cidade, 'uf', m.uf,
        'previsao_entrega', m.previsao_entrega, 'metragens', m.metragens, 'preco_a_partir', m.preco_a_partir,
        'resumo', m.resumo, 'descricao', m.descricao, 'lazer', to_jsonb(m.lazer), 'diferenciais', to_jsonb(m.diferenciais),
        'fotos', to_jsonb(m.fotos), 'plantas', to_jsonb(m.plantas), 'video_url', m.video_url,
        'latitude', m.latitude, 'longitude', m.longitude, 'link_oficial', m.link_oficial
      ) order by m.ordem, m.nome)
      from public.empreendimentos m
      where m.ativo
    ), '[]'::jsonb),
    'banners', coalesce((
      select jsonb_agg(jsonb_build_object(
        'imagem_url', b.imagem_url, 'imagem_celular_url', b.imagem_celular_url,
        'titulo', b.titulo, 'texto', b.texto, 'botao', b.botao, 'link', b.link
      ) order by b.ordem)
      from public.banners_site b
      where b.ativo
    ), '[]'::jsonb)
  );
$$;

-- Formulário do site: vira lead e segue a distribuição normal.
create or replace function public.pedir_informacoes_site(
  p_empreendimento text, p_nome text, p_telefone text, p_email text default null,
  p_mensagem text default null, p_visitante text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_emp public.empreendimentos;
  v_nome text := left(trim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), 80);
  v_tel text := interno.normalizar_whatsapp(p_telefone);
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_msg text := nullif(left(trim(coalesce(p_mensagem, '')), 500), '');
  v_visitante text := nullif(left(regexp_replace(coalesce(p_visitante, ''), '[^A-Za-z0-9-]', '', 'g'), 40), '');
  v_origem text;
  v_lead public.leads;
  v_novo boolean := false;
begin
  select * into v_emp from public.empreendimentos where slug = lower(trim(coalesce(p_empreendimento, ''))) and ativo;
  if v_emp.id is null then
    raise exception 'Empreendimento não encontrado';
  end if;
  if length(v_nome) < 2 then
    raise exception 'Informe seu nome';
  end if;
  if v_tel is null then
    raise exception 'Informe um telefone com DDD, por exemplo (67) 99999-0000';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Confira o e-mail';
  end if;
  -- Limites contra robôs e envios repetidos.
  if (select count(*) from public.pedidos_site where telefone = v_tel and criado_em > now() - interval '1 day') >= 3
     or (v_visitante is not null and (select count(*) from public.pedidos_site where visitante = v_visitante and criado_em > now() - interval '1 hour') >= 5)
     or (select count(*) from public.pedidos_site where criado_em > now() - interval '1 hour') >= 60 then
    raise exception 'Recebemos seu pedido. Se preferir, fale com a gente pelo WhatsApp.';
  end if;

  v_origem := 'Site – Empreendimento ' || v_emp.nome;
  select * into v_lead from public.leads where whatsapp = any (interno.variantes_whatsapp(v_tel)) limit 1;
  if v_lead.id is null then
    insert into public.leads (whatsapp, nome, email, origem, campanha, campanha_ia_id, resumo, ficha)
    values (
      v_tel, v_nome, v_email, 'site', v_origem, v_emp.campanha_ia_id,
      'Pediu informações do empreendimento ' || v_emp.nome || ' pelo formulário do site.',
      jsonb_build_object('empreendimento', v_emp.nome)
    )
    returning * into v_lead;
    v_novo := true;
  else
    update public.leads set
      nome = coalesce(nome, v_nome),
      email = coalesce(email, v_email),
      campanha_ia_id = coalesce(campanha_ia_id, v_emp.campanha_ia_id),
      excluido_em = null, excluido_por = null
    where id = v_lead.id
    returning * into v_lead;
  end if;

  insert into public.mensagens (lead_id, autor, conteudo)
  values (v_lead.id, 'sistema',
    'Pedido pelo site: quer receber informações do empreendimento ' || v_emp.nome || '.'
    || ' Nome: ' || v_nome || '.' || coalesce(' E-mail: ' || v_email || '.', '') || coalesce(' Mensagem: ' || v_msg, ''));
  insert into public.pedidos_site (empreendimento_id, lead_id, telefone, visitante) values (v_emp.id, v_lead.id, v_tel, v_visitante);

  -- Distribuição normal: corretor da vez (ou quem já atende o cliente).
  if v_lead.status <> 'com_corretor' then
    perform public.oferecer_lead(v_lead.id);
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo);
end;
$$;
revoke all on function public.pedir_informacoes_site(text, text, text, text, text, text) from public;
grant execute on function public.pedir_informacoes_site(text, text, text, text, text, text) to anon, authenticated;

-- Primeiro empreendimento: Atmosphere, da Plaenge (texto da campanha da Thais).
insert into public.empreendimentos (
  slug, nome, construtora, tipo, status, bairro, endereco, metragens, resumo, descricao, lazer, diferenciais, link_oficial, campanha_ia_id, ordem
)
select
  'atmosphere', 'Atmosphere', 'Plaenge', 'loteamento', 'lancamento', 'Chácara dos Poderes',
  'Rua Ide Abdul Ahad, Jardim Veraneio / Chácara dos Poderes',
  'Lotes de 250 m² a 450 m²',
  'O primeiro loteamento boutique de Campo Grande, com lotes de 250 a 450 m² e clube completo.',
  E'O Atmosphere, da Plaenge, é o primeiro loteamento boutique de Campo Grande.\n\n'
  || E'São lotes residenciais de 250 m² a 450 m², com rede elétrica subterrânea, vias pavimentadas e amplas áreas verdes. A arquitetura é do LW Design Group e o paisagismo, da CONDE Urban Design.\n\n'
  || E'Dá para financiar o lote junto com a construção da casa, e a liberação para o início das obras está prevista para o início de 2027. A LFG apresenta projetos prontos de casas térreas modernas e sobrados contemporâneos para o seu lote.\n\n'
  || 'Fica perto do Shopping Bosque dos Ipês e da Leroy Merlin, vizinho de condomínios de alto padrão, numa região em valorização.',
  array['Club House Sports', 'Piscina adulto e infantil', 'Fitness e outdoor fitness', 'Quadras de beach tennis, padel e poliesportiva',
    'Pista de caminhada', 'Sports grill', 'Lounge de festas', 'Kids play e playground', 'Games', 'Empório', 'Lobby com porte-cochère'],
  array['Rede elétrica subterrânea', 'Vias pavimentadas', 'Amplas áreas verdes', 'Arquitetura do LW Design Group',
    'Paisagismo da CONDE Urban Design', 'Financiamento do lote junto com a construção', 'Projetos prontos de casas da LFG'],
  'https://www.plaenge.com.br/campo-grande/atmosphere',
  (select id from public.campanhas_ia where nome ilike 'Atmosphere%' limit 1),
  1
where not exists (select 1 from public.empreendimentos where slug = 'atmosphere');
