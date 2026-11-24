-- Cadastro próprio de imóveis. Os que vêm do Univen seguem como espelho, só para
-- leitura; os cadastrados no painel (origem "proprio") não são tocados pela
-- sincronização e valem para a Thais e para o site quando estão disponíveis.

create sequence interno.imoveis_proprios_seq start 90000001;

alter table public.imoveis
  add column origem text not null default 'univen' check (origem in ('univen', 'proprio')),
  add column situacao text not null default 'disponivel' check (situacao in ('rascunho', 'disponivel', 'reservado', 'vendido', 'alugado', 'inativo')),
  add column foto_mini text,
  add column medida_frente numeric(10, 2),
  add column medida_fundo numeric(10, 2),
  add column mobilia text check (mobilia in ('mobiliado', 'semi', 'sem', 'desconhecido')),
  add column ocupacao text check (ocupacao in ('desocupado', 'proprietario', 'inquilino', 'desconhecido')),
  add column taxa_administracao numeric(5, 2);
comment on column public.imoveis.origem is 'univen: espelho do XML, só leitura. proprio: cadastrado no painel.';
comment on column public.imoveis.situacao is 'No imóvel próprio é a situação que manda: só "disponivel" fica ativo para a Thais e para o site.';
comment on column public.imoveis.foto_mini is 'Miniatura da capa, nos imóveis cujas fotos estão no nosso armazenamento.';
comment on column public.imoveis.ocupacao is 'Dado interno: não vai para a Thais nem para o site.';
comment on column public.imoveis.taxa_administracao is 'Percentual sobre o aluguel. Dado interno: não vai para a Thais nem para o site.';
create index imoveis_origem_situacao_idx on public.imoveis (origem, situacao);

update public.imoveis set situacao = case when ativo then 'disponivel' else 'inativo' end;

create function interno.acertar_situacao_do_imovel() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.origem = 'univen' then
    new.situacao := case when new.ativo then 'disponivel' else 'inativo' end;
  else
    new.ativo := new.situacao = 'disponivel';
    new.inativado_em := case when new.ativo then null else coalesce(new.inativado_em, now()) end;
  end if;
  return new;
end;
$$;

create trigger imoveis_acertar_situacao
before insert or update on public.imoveis
for each row execute function interno.acertar_situacao_do_imovel();

-- A sincronização e a consulta da Thais só tratam como "saiu do Univen" o que veio
-- de lá. Sem isso, um imóvel próprio seria inativado a cada 15 minutos.
do $migracao$
declare
  v_definicao text;
  v_nova text;
begin
  v_definicao := pg_get_functiondef('interno.sincronizar_imoveis()'::regprocedure);
  v_nova := replace(v_definicao, 'from public.imoveis where ativo;', 'from public.imoveis where ativo and origem = ''univen'';');
  v_nova := replace(v_nova, 'where ativo and codigo <> all (v_codigos);', 'where ativo and origem = ''univen'' and codigo <> all (v_codigos);');
  if v_nova = v_definicao or v_nova not like '%ativo and origem = ''univen'' and codigo%' or v_nova not like '%where ativo and origem = ''univen'';%' then
    raise exception 'Não consegui ajustar interno.sincronizar_imoveis';
  end if;
  execute v_nova;

  v_definicao := pg_get_functiondef('public.ia_consultar_imovel(text)'::regprocedure);
  v_nova := replace(
    v_definicao,
    'v_ativo := interno.ativo_no_univen(v_imovel.codigo);',
    'v_ativo := case when v_imovel.origem = ''proprio'' then v_imovel.ativo else interno.ativo_no_univen(v_imovel.codigo) end;'
  );
  if v_nova = v_definicao then
    raise exception 'Não consegui ajustar public.ia_consultar_imovel';
  end if;
  execute v_nova;
end;
$migracao$;

-- Fotos dos imóveis próprios: públicas para ler (o site usa). A equipe envia;
-- apaga quem enviou ou o gestor.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imoveis', 'imoveis', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Equipe vê as fotos dos imóveis" on storage.objects
  for select to authenticated using (bucket_id = 'imoveis');
create policy "Equipe envia fotos dos imóveis" on storage.objects
  for insert to authenticated with check (bucket_id = 'imoveis' and (select interno.meu_corretor_id()) is not null);
create policy "Quem enviou ou o gestor apaga fotos dos imóveis" on storage.objects
  for delete to authenticated using (
    bucket_id = 'imoveis' and ((select interno.sou_gestor()) or owner_id = (select auth.uid())::text)
  );

-- Cria (p_codigo nulo) ou atualiza um imóvel próprio. O painel manda a ficha inteira.
create function public.salvar_imovel(p_codigo text, p_dados jsonb)
returns public.imoveis
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_gestor boolean := interno.sou_gestor();
  v_atual public.imoveis;
  v_imovel public.imoveis;
  v_codigo text := p_codigo;
  v_situacao text := coalesce(nullif(p_dados ->> 'situacao', ''), 'rascunho');
  v_venda boolean := coalesce((p_dados ->> 'venda')::boolean, false);
  v_locacao boolean := coalesce((p_dados ->> 'locacao')::boolean, false);
  v_valor_venda numeric := nullif(p_dados ->> 'valor_venda', '')::numeric;
  v_valor_locacao numeric := nullif(p_dados ->> 'valor_locacao', '')::numeric;
  v_tipo text := nullif(upper(trim(p_dados ->> 'tipo')), '');
  v_bairro text := nullif(trim(p_dados ->> 'bairro'), '');
  v_cidade text := nullif(trim(p_dados ->> 'cidade'), '');
  v_uf text := nullif(upper(trim(p_dados ->> 'uf')), '');
  v_fotos text[] := array(select jsonb_array_elements_text(coalesce(p_dados -> 'fotos', '[]'::jsonb)));
  v_prefixo text := upper(trim(coalesce(p_dados ->> 'prefixo', '')));
  v_referencia text;
  v_captador text;
  v_base text;
begin
  if v_eu is null then
    raise exception 'Entre no painel para cadastrar imóveis';
  end if;
  if v_situacao not in ('rascunho', 'disponivel', 'reservado', 'vendido', 'alugado', 'inativo') then
    raise exception 'Situação inválida';
  end if;
  if v_tipo is null then
    raise exception 'Escolha o tipo do imóvel';
  end if;

  if v_codigo is not null then
    select * into v_atual from public.imoveis where codigo = v_codigo for update;
    if not found then
      raise exception 'Imóvel não encontrado';
    end if;
    if v_atual.origem <> 'proprio' then
      raise exception 'Este imóvel vem do Univen: edite por lá até a troca dos portais';
    end if;
    if not (v_gestor or interno.corretor_do_captador(v_atual.captador) = v_eu) then
      raise exception 'Só o captador do imóvel ou o gestor podem editar';
    end if;
  end if;

  if v_situacao = 'disponivel' then
    if v_bairro is null or v_cidade is null or v_uf is null then
      raise exception 'Para publicar, preencha bairro, cidade e estado';
    end if;
    if not ((v_venda and coalesce(v_valor_venda, 0) > 0) or (v_locacao and coalesce(v_valor_locacao, 0) > 0)) then
      raise exception 'Para publicar, informe o valor de venda ou de aluguel';
    end if;
    if cardinality(v_fotos) = 0 then
      raise exception 'Para publicar, envie pelo menos uma foto';
    end if;
  end if;

  -- O gestor escolhe o captador; o corretor é captador do que cadastra.
  select coalesce(c.nome_no_univen, c.nome) into v_captador
  from public.corretores c
  where c.ativo and c.id = case
    when v_gestor and nullif(p_dados ->> 'captador_id', '') is not null then (p_dados ->> 'captador_id')::uuid
    when v_atual.codigo is null then v_eu
  end;
  v_captador := coalesce(v_captador, v_atual.captador);

  if v_codigo is null then
    if v_prefixo !~ '^[A-Z]{2}$' then
      raise exception 'Tipo de imóvel sem prefixo de referência';
    end if;
    perform pg_advisory_xact_lock(hashtext('imoveis_referencia'));
    select v_prefixo || lpad((coalesce(max(substring(i.referencia from 3)::integer), 0) + 1)::text, 5, '0') into v_referencia
    from public.imoveis i
    where i.referencia ~ ('^' || v_prefixo || '[0-9]{5}$');
    v_codigo := nextval('interno.imoveis_proprios_seq')::text;
    insert into public.imoveis (codigo, referencia, origem, situacao, tipo, captador)
    values (v_codigo, v_referencia, 'proprio', 'rascunho', v_tipo, v_captador);
  else
    v_referencia := v_atual.referencia;
  end if;

  select nullif(rtrim(c.valor ->> 'endereco_site', '/'), '') into v_base from public.configuracoes c where c.chave = 'site';

  update public.imoveis i set
    situacao = v_situacao,
    tipo = v_tipo,
    finalidade = nullif(p_dados ->> 'finalidade', ''),
    captador = v_captador,
    venda = v_venda,
    locacao = v_locacao,
    valor_venda = case when v_venda then v_valor_venda end,
    valor_locacao = case when v_locacao then v_valor_locacao end,
    valor_condominio = nullif(p_dados ->> 'valor_condominio', '')::numeric,
    valor_iptu = nullif(p_dados ->> 'valor_iptu', '')::numeric,
    taxa_administracao = nullif(p_dados ->> 'taxa_administracao', '')::numeric,
    dormitorios = nullif(p_dados ->> 'dormitorios', '')::integer,
    suites = nullif(p_dados ->> 'suites', '')::integer,
    banheiros = nullif(p_dados ->> 'banheiros', '')::integer,
    vagas = nullif(p_dados ->> 'vagas', '')::integer,
    area_construida = nullif(p_dados ->> 'area_construida', '')::numeric,
    area_util = nullif(p_dados ->> 'area_util', '')::numeric,
    area_terreno = nullif(p_dados ->> 'area_terreno', '')::numeric,
    medida_frente = nullif(p_dados ->> 'medida_frente', '')::numeric,
    medida_fundo = nullif(p_dados ->> 'medida_fundo', '')::numeric,
    cep = nullif(trim(p_dados ->> 'cep'), ''),
    endereco = nullif(trim(p_dados ->> 'endereco'), ''),
    numero = nullif(trim(p_dados ->> 'numero'), ''),
    complemento = nullif(trim(p_dados ->> 'complemento'), ''),
    bairro = v_bairro,
    cidade = v_cidade,
    uf = v_uf,
    titulo = nullif(trim(p_dados ->> 'titulo'), ''),
    descricao = nullif(trim(p_dados ->> 'descricao'), ''),
    fotos = v_fotos,
    foto_principal = v_fotos[1],
    foto_mini = nullif(p_dados ->> 'foto_mini', ''),
    mobilia = nullif(p_dados ->> 'mobilia', ''),
    mobiliado = (p_dados ->> 'mobilia') = 'mobiliado',
    ocupacao = nullif(p_dados ->> 'ocupacao', ''),
    aceita_pet = coalesce((p_dados ->> 'aceita_pet')::boolean, false),
    aceita_financiamento = case when coalesce((p_dados ->> 'aceita_financiamento')::boolean, false) then 1 else 0 end,
    caracteristicas = coalesce(p_dados -> 'caracteristicas', '{}'::jsonb),
    link_site = case when v_base is not null then v_base || '/imovel/' || v_referencia || '/' end,
    atualizado_univen = current_date,
    sincronizado_em = now()
  where i.codigo = v_codigo
  returning * into v_imovel;
  return v_imovel;
end;
$$;

-- Rascunho pode ser apagado; imóvel que já foi publicado muda de situação.
create function public.apagar_rascunho(p_codigo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_imovel public.imoveis;
begin
  select * into v_imovel from public.imoveis where codigo = p_codigo for update;
  if not found or v_imovel.origem <> 'proprio' or v_imovel.situacao <> 'rascunho' then
    raise exception 'Só rascunhos do cadastro próprio podem ser apagados';
  end if;
  if not (interno.sou_gestor() or interno.corretor_do_captador(v_imovel.captador) = interno.meu_corretor_id()) then
    raise exception 'Só o captador do imóvel ou o gestor podem apagar';
  end if;
  delete from public.imoveis where codigo = p_codigo;
end;
$$;

-- O site passa a usar a miniatura da capa quando ela existe.
create or replace function public.site_dados() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'config', (select c.valor from public.configuracoes c where c.chave = 'site'),
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
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.salvar_imovel(text, jsonb) from public, anon;
revoke execute on function public.apagar_rascunho(text) from public, anon;
grant execute on function public.salvar_imovel(text, jsonb) to authenticated;
grant execute on function public.apagar_rascunho(text) to authenticated;
