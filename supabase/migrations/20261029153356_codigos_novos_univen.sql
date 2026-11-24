-- Em 29/10 o Univen trocou o código (e o link no site) de todos os imóveis: os
-- mesmos imóveis, com a mesma referência e o mesmo endereço, voltaram no XML com
-- códigos novos, e a sincronização os gravou como imóveis novos, inativando os
-- antigos. Cada imóvel fica só com o registro novo, guardando o código antigo,
-- para links e códigos antigos (anúncios, conversas) continuarem valendo.

alter table public.imoveis add column codigo_anterior text;
comment on column public.imoveis.codigo_anterior is 'Código que o imóvel tinha no Univen antes da troca de códigos de 29/10/2026.';
create index imoveis_codigo_anterior_idx on public.imoveis (codigo_anterior) where codigo_anterior is not null;

update public.imoveis n
set codigo_anterior = v.codigo
from public.imoveis v
where n.ativo and not v.ativo and v.referencia = n.referencia and v.codigo <> n.codigo;

update public.leads l
set imovel_codigo = i.codigo
from public.imoveis i
where i.codigo_anterior = l.imovel_codigo;

delete from public.imoveis v
where not v.ativo and exists (select 1 from public.imoveis n where n.codigo_anterior = v.codigo);

-- A busca acha o imóvel também pelo código antigo e, havendo mais de um
-- registro, prefere o ativo e o mais recente.
create or replace function public.ia_consultar_imovel(p_busca text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_chave text := upper(trim(coalesce(p_busca, '')));
  v_codigo_link text := substring(trim(coalesce(p_busca, '')) from '([0-9]{6,})/?$');
  v_imovel public.imoveis;
  v_ativo boolean;
begin
  select * into v_imovel from public.imoveis
  where referencia = v_chave
     or codigo in (v_chave, v_codigo_link)
     or codigo_anterior in (v_chave, v_codigo_link)
  order by ativo desc, sincronizado_em desc nulls last
  limit 1;

  -- Imóvel cadastrado depois da última sincronização: sincroniza e tenta de novo,
  -- no máximo uma vez a cada 2 minutos.
  if not found and not exists (
    select 1 from public.sincronizacoes where iniciada_em > now() - interval '2 minutes'
  ) then
    perform interno.sincronizar_imoveis();
    select * into v_imovel from public.imoveis
    where referencia = v_chave
       or codigo in (v_chave, v_codigo_link)
       or codigo_anterior in (v_chave, v_codigo_link)
    order by ativo desc, sincronizado_em desc nulls last
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
