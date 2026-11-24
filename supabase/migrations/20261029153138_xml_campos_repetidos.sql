-- Desde 29/10 às 04:00 o XML do Univen traz Suite e Numero duas vezes em cada
-- imóvel (com o mesmo valor) e a leitura parava com "more than one value
-- returned by column XPath expression". Cada campo passa a ler só a primeira
-- ocorrência, para uma repetição nova do Univen não parar a sincronização.
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
        codigo text path 'Codigoimovel[1]',
        referencia text path 'Referencia[1]',
        tipo text path 'Tipo[1]',
        categoria text path 'Categoria[1]',
        finalidade text path 'Finalidade[1]',
        venda text path 'Venda[1]',
        locacao text path 'Locacao[1]',
        valor_venda text path 'Valorvenda[1]',
        valor_locacao text path 'Valorlocacao[1]',
        valor_promocional text path 'Valorpromocional[1]',
        valor_condominio text path 'Valorcondominio[1]',
        valor_iptu text path 'Valoriptu[1]',
        dormitorios text path 'Dormitorios[1]',
        suites text path 'Suite[1]',
        banheiros text path 'Banheiro2[1]',
        banheiros_alt text path 'Banheiro[1]',
        vagas text path 'Garagem[1]',
        area_construida text path 'Areacosntruida[1]',
        area_terreno text path 'Areaterreno[1]',
        area_util text path 'Areautil[1]',
        endereco text path 'Endereco[1]',
        numero text path 'Numero[1]',
        complemento text path 'Complemento[1]',
        bairro text path 'Bairro[1]',
        cidade text path 'Cidade[1]',
        uf text path 'UnidadeFederativa[1]',
        cep text path 'CEP[1]',
        latitude text path 'Latitude[1]',
        longitude text path 'Longitude[1]',
        titulo text path 'Titulo[1]',
        segundo_titulo text path 'Segundotitulo[1]',
        descricao text path 'Anuncioparainternet[1]',
        link_site text path 'LinkImovelSite[1]',
        aceita_financiamento text path 'Aceitafinanciamento[1]',
        aceita_pet text path 'AceitaPet[1]',
        mobiliado text path 'Mobiliado[1]',
        atualizado text path 'Atualizadoem[1]',
        captador text path 'Captador[1]',
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
