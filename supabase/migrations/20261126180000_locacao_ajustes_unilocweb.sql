-- Locação, ajustes vindos da análise do Unilocweb (26/11):
-- * Supervisor do contrato: qualquer pessoa ativa da equipe (no Unilocweb há
--   supervisores que não são gestor nem administrativo).
-- * Preferência de pagamento: + 'boleto_email' e 'recibo' (opções do Unilocweb,
--   para a importação).

alter table public.contratos drop constraint if exists contratos_preferencia_pagamento_check;
alter table public.contratos add constraint contratos_preferencia_pagamento_check
  check (preferencia_pagamento in ('indiferente', 'boleto', 'boleto_email', 'recibo', 'pix', 'deposito'));

create or replace function public.salvar_contrato(p_id uuid, p_dados jsonb, p_locatarios uuid[], p_fiadores uuid[])
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_atual public.contratos;
  v_id uuid;
  v_ativo boolean := false;
  d jsonb := coalesce(p_dados, '{}');
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if p_id is not null then
    select * into v_atual from public.contratos where id = p_id for update;
    if v_atual.id is null then raise exception 'Contrato não encontrado'; end if;
    if v_atual.situacao in ('rescindido', 'encerrado') then raise exception 'Contrato encerrado não pode ser alterado'; end if;
    v_ativo := v_atual.situacao = 'ativo';
  end if;
  if nullif(d ->> 'supervisor_id', '') is not null and not exists (
    select 1 from public.corretores c where c.id = (d ->> 'supervisor_id')::uuid and c.ativo) then
    raise exception 'O supervisor tem que ser alguém ativo da equipe';
  end if;
  if nullif(d ->> 'imovel_codigo', '') is not null and not exists (select 1 from public.imoveis_locacao where imovel_codigo = d ->> 'imovel_codigo') then
    raise exception 'Imóvel não está em Imóveis administrados';
  end if;
  if exists (select 1 from unnest(coalesce(p_locatarios, '{}') || coalesce(p_fiadores, '{}')) x where not exists (select 1 from public.pessoas p where p.id = x)) then
    raise exception 'Locatário ou fiador não encontrado';
  end if;

  if p_id is null then
    insert into public.contratos (criado_por) values (interno.meu_corretor_id()) returning id into v_id;
  else
    v_id := p_id;
  end if;

  update public.contratos c set
    titulo_rascunho = nullif(trim(d ->> 'titulo_rascunho'), ''),
    imovel_codigo = case when v_ativo then c.imovel_codigo else nullif(d ->> 'imovel_codigo', '') end,
    regime_tributario = coalesce(nullif(d ->> 'regime_tributario', ''), 'nao_informado'),
    preferencia_pagamento = coalesce(nullif(d ->> 'preferencia_pagamento', ''), 'indiferente'),
    desconto_pontualidade = coalesce(nullif(d ->> 'desconto_pontualidade', '')::numeric, 0),
    finalidade = coalesce(nullif(d ->> 'finalidade', ''), 'residencial'),
    valor_inicial = case when v_ativo then c.valor_inicial else nullif(d ->> 'valor_inicial', '')::numeric end,
    indice = coalesce(nullif(d ->> 'indice', ''), 'IGP-M'),
    indice_fixo = nullif(d ->> 'indice_fixo', '')::numeric,
    controle = nullif(trim(d ->> 'controle'), ''),
    garantia_aluguel = coalesce((d ->> 'garantia_aluguel')::boolean, false),
    garantia_aluguel_meses = nullif(d ->> 'garantia_aluguel_meses', '')::int,
    inicio = case when v_ativo then c.inicio else nullif(d ->> 'inicio', '')::date end,
    prazo_meses = case when v_ativo then c.prazo_meses else nullif(d ->> 'prazo_meses', '')::int end,
    reajuste_meses = case when v_ativo then c.reajuste_meses else nullif(d ->> 'reajuste_meses', '')::int end,
    dia_inicio_periodo = case when v_ativo then c.dia_inicio_periodo else nullif(d ->> 'dia_inicio_periodo', '')::int end,
    dia_cobranca = case when v_ativo then c.dia_cobranca else nullif(d ->> 'dia_cobranca', '')::int end,
    cobranca_referencia = case when v_ativo then c.cobranca_referencia else coalesce(nullif(d ->> 'cobranca_referencia', ''), 'apos_periodo') end,
    dia_repasse = case when v_ativo then c.dia_repasse else nullif(d ->> 'dia_repasse', '')::int end,
    repasse_referencia = case when v_ativo then c.repasse_referencia else coalesce(nullif(d ->> 'repasse_referencia', ''), 'apos_periodo') end,
    taxa_administracao = nullif(d ->> 'taxa_administracao', '')::numeric,
    taxa_base = coalesce(nullif(d ->> 'taxa_base', ''), 'percentual_aluguel'),
    taxa_proporcional = case when v_ativo then c.taxa_proporcional else coalesce((d ->> 'taxa_proporcional')::boolean, true) end,
    taxa_intermediacao = nullif(d ->> 'taxa_intermediacao', '')::numeric,
    multa_percentual = coalesce(nullif(d ->> 'multa_percentual', '')::numeric, 10),
    multa_forma = coalesce(nullif(d ->> 'multa_forma', ''), 'integral'),
    multa_base = coalesce(nullif(d ->> 'multa_base', ''), 'total'),
    multa_a_partir_dia = coalesce(nullif(d ->> 'multa_a_partir_dia', '')::int, 1),
    multa_pj_omitir = coalesce((d ->> 'multa_pj_omitir')::boolean, false),
    juros_percentual = coalesce(nullif(d ->> 'juros_percentual', '')::numeric, 0.033),
    juros_periodo = coalesce(nullif(d ->> 'juros_periodo', ''), 'dia'),
    juros_a_partir_dia = coalesce(nullif(d ->> 'juros_a_partir_dia', '')::int, 1),
    irrf_modo = coalesce(nullif(d ->> 'irrf_modo', ''), 'percentual'),
    garantia_tipo = coalesce(nullif(d ->> 'garantia_tipo', ''), 'nenhuma'),
    garantia_dados = coalesce(d -> 'garantia_dados', '{}'),
    supervisor_id = nullif(d ->> 'supervisor_id', '')::uuid,
    comissao_supervisor = coalesce(nullif(d ->> 'comissao_supervisor', '')::numeric, 0),
    clausula_pintura = coalesce((d ->> 'clausula_pintura')::boolean, false),
    clausula_meses = coalesce((d ->> 'clausula_meses')::boolean, false),
    unidade_id = nullif(d ->> 'unidade_id', '')::uuid,
    liberado_lancamentos = coalesce((d ->> 'liberado_lancamentos')::boolean, true),
    fora_do_lote = coalesce((d ->> 'fora_do_lote')::boolean, false),
    contrato_parcial = coalesce((d ->> 'contrato_parcial')::boolean, false),
    movimentacao_desde = case when v_ativo then c.movimentacao_desde else nullif(d ->> 'movimentacao_desde', '')::date end,
    movimentacao_proporcional = coalesce((d ->> 'movimentacao_proporcional')::boolean, false),
    ultimo_reajuste_em = case when v_ativo then c.ultimo_reajuste_em else nullif(d ->> 'ultimo_reajuste_em', '')::date end,
    valor_vigente = case when v_ativo then c.valor_vigente else nullif(d ->> 'valor_vigente', '')::numeric end,
    meses_para_reajuste = case when v_ativo then c.meses_para_reajuste else nullif(d ->> 'meses_para_reajuste', '')::int end,
    multa_rescisoria_alugueis = coalesce(nullif(d ->> 'multa_rescisoria_alugueis', '')::numeric, 3),
    observacoes = nullif(trim(d ->> 'observacoes'), ''),
    lead_id = coalesce(nullif(d ->> 'lead_id', '')::uuid, c.lead_id),
    atualizado_em = now()
  where c.id = v_id;

  -- Locatários e fiadores: a lista inteira, na ordem da tela.
  delete from public.contrato_partes cp where cp.contrato_id = v_id and cp.papel in ('locatario', 'fiador')
    and not ((cp.papel = 'locatario' and cp.pessoa_id = any (coalesce(p_locatarios, '{}'))) or (cp.papel = 'fiador' and cp.pessoa_id = any (coalesce(p_fiadores, '{}'))));
  insert into public.contrato_partes (contrato_id, pessoa_id, papel, ordem)
  select v_id, x, 'locatario', o from unnest(coalesce(p_locatarios, '{}')) with ordinality as t(x, o)
  on conflict (contrato_id, pessoa_id, papel) do update set ordem = excluded.ordem where contrato_partes.ordem <> excluded.ordem;
  insert into public.contrato_partes (contrato_id, pessoa_id, papel, ordem)
  select v_id, x, 'fiador', o from unnest(coalesce(p_fiadores, '{}')) with ordinality as t(x, o)
  on conflict (contrato_id, pessoa_id, papel) do update set ordem = excluded.ordem where contrato_partes.ordem <> excluded.ordem;
  -- Papel de cada pessoa no cadastro.
  update public.pessoas p set papeis = array_append(p.papeis, 'locatario'), atualizado_em = now()
  where p.id = any (coalesce(p_locatarios, '{}')) and not ('locatario' = any (p.papeis));
  update public.pessoas p set papeis = array_append(p.papeis, 'fiador'), atualizado_em = now()
  where p.id = any (coalesce(p_fiadores, '{}')) and not ('fiador' = any (p.papeis));
  return v_id;
end;
$$;
revoke all on function public.salvar_contrato(uuid, jsonb, uuid[], uuid[]) from public, anon;
grant execute on function public.salvar_contrato(uuid, jsonb, uuid[], uuid[]) to authenticated;
