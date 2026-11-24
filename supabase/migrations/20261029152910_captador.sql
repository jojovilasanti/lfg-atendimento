-- Regra principal de distribuição da LFG: o lead vai para o captador do imóvel
-- de interesse (campo Captador do Univen), de plantão ou não. Sem imóvel de
-- interesse, ou quando o captador não está cadastrado (com WhatsApp), não
-- assume no prazo ou recusa, o lead segue para o rodízio de plantão.

alter table public.imoveis add column captador text;
comment on column public.imoveis.captador is 'Nome do captador no Univen (campo Captador do XML).';

alter table public.corretores add column nome_no_univen text;
comment on column public.corretores.nome_no_univen is 'Nome da pessoa como captador no Univen, quando é diferente do nome do cadastro (ex.: JoJo).';

create type public.atribuicao_motivo as enum ('captador', 'rodizio');
alter table public.atribuicoes add column motivo public.atribuicao_motivo not null default 'rodizio';
comment on column public.atribuicoes.motivo is 'captador: oferta ao captador do imóvel de interesse; rodizio: corretor de plantão da vez.';

-- Pessoa da equipe que é o captador do Univen, sem diferenciar maiúsculas e
-- acentos: vale o "nome no Univen" e, sem ele, o nome do cadastro.
create function interno.corretor_do_captador(p_captador text) returns uuid
language sql stable security definer set search_path = ''
as $$
  select c.id
  from public.corretores c
  where c.ativo
    and interno.texto(p_captador) is not null
    and interno.sem_acento(trim(coalesce(c.nome_no_univen, c.nome))) = interno.sem_acento(trim(p_captador))
  order by c.nome_no_univen is null, c.criado_em
  limit 1
$$;

-- Captadores do estoque ativo e quem da equipe corresponde a cada um (tela Equipe).
create function public.captadores_do_univen()
returns table (captador text, imoveis_ativos bigint, corretor_id uuid)
language sql stable security invoker set search_path = ''
as $$
  select i.captador, count(*), interno.corretor_do_captador(i.captador)
  from public.imoveis i
  where i.ativo and i.captador is not null
  group by i.captador
  order by count(*) desc, i.captador
$$;

revoke execute on function public.captadores_do_univen() from public, anon;
grant execute on function public.captadores_do_univen() to authenticated;

-- A sincronização passa a guardar o captador.
create or replace function interno.sincronizar_imoveis() returns public.sincronizacoes
language plpgsql security definer set search_path = ''
as $$
declare
  v_execucao public.sincronizacoes;
  v_resposta extensions.http_response;
  v_xml xml;
  v_ativos_antes integer;
  v_codigos text[];
  v_inativados integer;
begin
  insert into public.sincronizacoes default values returning * into v_execucao;

  begin
    select count(*) into v_ativos_antes from public.imoveis where ativo;

    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '60');
    v_resposta := extensions.http_get('https://integracaounion.com.br/union/42115/42115.xml');
    if v_resposta.status <> 200 then
      raise exception 'XML do Univen respondeu HTTP %', v_resposta.status;
    end if;
    v_xml := xmlparse(document ltrim(v_resposta.content, U&'\FEFF'));

    with xml_imoveis as (
      select x.*
      from xmltable('/Union/Imoveis/Imovel' passing v_xml columns
        codigo text path 'Codigoimovel',
        referencia text path 'Referencia',
        tipo text path 'Tipo',
        categoria text path 'Categoria',
        finalidade text path 'Finalidade',
        venda text path 'Venda',
        locacao text path 'Locacao',
        valor_venda text path 'Valorvenda',
        valor_locacao text path 'Valorlocacao',
        valor_promocional text path 'Valorpromocional',
        valor_condominio text path 'Valorcondominio',
        valor_iptu text path 'Valoriptu',
        dormitorios text path 'Dormitorios',
        suites text path 'Suite',
        banheiros text path 'Banheiro2',
        banheiros_alt text path 'Banheiro',
        vagas text path 'Garagem',
        area_construida text path 'Areacosntruida',
        area_terreno text path 'Areaterreno',
        area_util text path 'Areautil',
        endereco text path 'Endereco',
        numero text path 'Numero',
        complemento text path 'Complemento',
        bairro text path 'Bairro',
        cidade text path 'Cidade',
        uf text path 'UnidadeFederativa',
        cep text path 'CEP',
        latitude text path 'Latitude',
        longitude text path 'Longitude',
        titulo text path 'Titulo',
        segundo_titulo text path 'Segundotitulo',
        descricao text path 'Anuncioparainternet',
        link_site text path 'LinkImovelSite',
        aceita_financiamento text path 'Aceitafinanciamento',
        aceita_pet text path 'AceitaPet',
        mobiliado text path 'Mobiliado',
        atualizado text path 'Atualizadoem',
        captador text path 'Captador',
        imovel_xml xml path '.'
      ) as x
      where interno.texto(x.codigo) is not null
    ),
    gravados as (
      insert into public.imoveis as i (
        codigo, referencia, tipo, categoria, finalidade, venda, locacao,
        valor_venda, valor_locacao, valor_promocional, valor_condominio, valor_iptu,
        dormitorios, suites, banheiros, vagas, area_construida, area_terreno, area_util,
        endereco, numero, complemento, bairro, cidade, uf, cep, latitude, longitude,
        titulo, descricao, link_site, foto_principal, fotos,
        aceita_financiamento, aceita_pet, mobiliado, caracteristicas,
        ativo, atualizado_univen, sincronizado_em, inativado_em, captador
      )
      select
        trim(x.codigo),
        interno.texto(x.referencia),
        interno.texto(x.tipo),
        interno.texto(x.categoria),
        interno.texto(x.finalidade),
        interno.sim_nao(x.venda),
        interno.sim_nao(x.locacao),
        interno.numero(x.valor_venda),
        interno.numero(x.valor_locacao),
        interno.numero(x.valor_promocional),
        interno.numero(x.valor_condominio),
        interno.numero(x.valor_iptu),
        interno.numero(x.dormitorios)::integer,
        interno.numero(x.suites)::integer,
        coalesce(interno.numero(x.banheiros), interno.numero(x.banheiros_alt))::integer,
        interno.numero(x.vagas)::integer,
        interno.numero(x.area_construida),
        interno.numero(x.area_terreno),
        interno.numero(x.area_util),
        interno.texto(x.endereco),
        interno.texto(x.numero),
        interno.texto(x.complemento),
        interno.texto(x.bairro),
        interno.texto(x.cidade),
        interno.texto(x.uf),
        interno.texto(x.cep),
        interno.numero(x.latitude)::double precision,
        interno.numero(x.longitude)::double precision,
        coalesce(interno.texto(x.titulo), interno.texto(x.segundo_titulo)),
        interno.texto(x.descricao),
        interno.texto(x.link_site),
        coalesce(fotos.principal, fotos.urls[1]),
        coalesce(fotos.urls, '{}'),
        interno.numero(x.aceita_financiamento)::smallint,
        interno.sim_nao(x.aceita_pet),
        interno.sim_nao(x.mobiliado),
        coalesce(caracteristicas.dados, '{}'),
        true,
        interno.data_br(x.atualizado),
        now(),
        null,
        interno.texto(x.captador)
      from xml_imoveis x
      left join lateral (
        select
          array_agg(trim(f.url) order by f.ordem) filter (where interno.texto(f.url) is not null) as urls,
          (array_agg(trim(f.url) order by f.ordem) filter (where trim(f.principal) = '1' and interno.texto(f.url) is not null))[1] as principal
        from xmltable('/Imovel/Fotos/Foto' passing x.imovel_xml columns
          ordem for ordinality,
          url text path 'URL',
          principal text path 'Principal'
        ) as f
      ) as fotos on true
      left join lateral (
        -- Campos que não viraram coluna, sem dados administrativos ou internos
        -- (captador, onde ficam as chaves, contatos da imobiliária, SEO).
        select jsonb_object_agg(c.nome, trim(c.valor)) as dados
        from xmltable('/Imovel/*[not(*)]' passing x.imovel_xml columns
          nome text path 'local-name()',
          valor text path '.'
        ) as c
        where trim(c.valor) not in ('', '0', '0.00')
          and c.nome <> all (array[
            'Codigoimovel', 'Referencia', 'Tipo', 'Categoria', 'Finalidade', 'Venda', 'Locacao',
            'Valorvenda', 'Valorlocacao', 'Valorpromocional', 'Valorcondominio', 'Valoriptu',
            'Dormitorios', 'Suite', 'Banheiro', 'Banheiro2', 'Garagem',
            'Areacosntruida', 'Areaterreno', 'Areautil', 'Endereco', 'Numero', 'Complemento',
            'Bairro', 'Cidade', 'UnidadeFederativa', 'CEP', 'Latitude', 'Longitude',
            'Titulo', 'Segundotitulo', 'Anuncioparainternet', 'LinkImovelSite',
            'Aceitafinanciamento', 'AceitaPet', 'Mobiliado', 'Atualizadoem',
            'NomeImobiliaria', 'CodigoImobiliaria', 'SiteImobiliaria', 'EmailImobiliaria',
            'TelefoneImobiliaria', 'TelefoneImobiliaria2', 'TelefoneImobiliaria3',
            'Cadastradoem', 'Atualizadopor', 'Cadastradopor', 'Captador', 'Corretor', 'Localchaves',
            'Dataatual', 'Dataatulemingles', 'Datacadastroemingels', 'Somentedata', 'Somentehora',
            'Dataatualcompleta', 'Dataativacao', 'Dataexclussao', 'PalavraschavesSEO', 'MetadescriptionSEO',
            'Pais', 'Reserva', 'Bairrocomercial', 'Precomediovenda', 'Precomediolocacao',
            'Areaterrenosemdeciamal', 'Areacosntruidasemdeciamal', 'Areautilsemdeciamal',
            'Areatotalsemdeciamal', 'Areacomunsemdeciamal', 'Destaque', 'Oportunidadenegocio',
            'Contratoexclusividade'
          ])
      ) as caracteristicas on true
      on conflict (codigo) do update set
        referencia = excluded.referencia,
        tipo = excluded.tipo,
        categoria = excluded.categoria,
        finalidade = excluded.finalidade,
        venda = excluded.venda,
        locacao = excluded.locacao,
        valor_venda = excluded.valor_venda,
        valor_locacao = excluded.valor_locacao,
        valor_promocional = excluded.valor_promocional,
        valor_condominio = excluded.valor_condominio,
        valor_iptu = excluded.valor_iptu,
        dormitorios = excluded.dormitorios,
        suites = excluded.suites,
        banheiros = excluded.banheiros,
        vagas = excluded.vagas,
        area_construida = excluded.area_construida,
        area_terreno = excluded.area_terreno,
        area_util = excluded.area_util,
        endereco = excluded.endereco,
        numero = excluded.numero,
        complemento = excluded.complemento,
        bairro = excluded.bairro,
        cidade = excluded.cidade,
        uf = excluded.uf,
        cep = excluded.cep,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        titulo = excluded.titulo,
        descricao = excluded.descricao,
        link_site = excluded.link_site,
        foto_principal = excluded.foto_principal,
        fotos = excluded.fotos,
        aceita_financiamento = excluded.aceita_financiamento,
        aceita_pet = excluded.aceita_pet,
        mobiliado = excluded.mobiliado,
        caracteristicas = excluded.caracteristicas,
        ativo = true,
        atualizado_univen = excluded.atualizado_univen,
        sincronizado_em = excluded.sincronizado_em,
        inativado_em = null,
        captador = excluded.captador
      returning i.codigo
    )
    select array_agg(codigo) into v_codigos from gravados;

    -- Um XML vazio ou pela metade (falha do Univen) não pode desativar o estoque.
    if coalesce(cardinality(v_codigos), 0) = 0
       or (v_ativos_antes >= 20 and cardinality(v_codigos) < v_ativos_antes / 2) then
      raise exception 'XML do Univen trouxe % imóveis, mas havia % ativos; nada foi alterado',
        coalesce(cardinality(v_codigos), 0), v_ativos_antes;
    end if;

    update public.imoveis
    set ativo = false, inativado_em = now()
    where ativo and codigo <> all (v_codigos);
    get diagnostics v_inativados = row_count;

    update public.sincronizacoes
    set finalizada_em = now(), sucesso = true,
        imoveis_no_xml = cardinality(v_codigos), inativados = v_inativados
    where id = v_execucao.id
    returning * into v_execucao;
  exception when others then
    update public.sincronizacoes
    set finalizada_em = now(), sucesso = false, erro = sqlerrm
    where id = v_execucao.id
    returning * into v_execucao;
  end;

  return v_execucao;
end;
$$;

-- Oferta: primeiro o captador do imóvel de interesse; depois o rodízio de
-- plantão, onde vem primeiro quem está há mais tempo sem receber lead do rodízio.
create or replace function public.oferecer_lead(p_lead_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
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

  if v_corretor.id is null then
    select c.* into v_corretor
    from public.corretores c
    where c.ativo and c.no_rodizio and c.de_plantao
      and not exists (
        select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.corretor_id = c.id
      )
    order by
      (select max(a.oferecida_em) from public.atribuicoes a where a.corretor_id = c.id and a.motivo = 'rodizio') asc nulls first,
      c.ordem_rodizio asc nulls last,
      c.nome
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
$$;
