-- O gestor passa um lead para outro corretor pelo painel. Duas formas:
-- - com aviso: o corretor recebe o "novo_lead" no WhatsApp e tem o prazo do
--   rodízio para assumir; se não assumir, o lead segue o caminho normal
--   (captador, se ainda não foi oferecido, ou rodízio de plantão);
-- - direto: o gestor já combinou com o corretor, o lead fica com ele na hora.
-- A oferta que estava aberta é cancelada.

alter type public.atribuicao_motivo add value if not exists 'gestor';

create function public.passar_lead(p_lead_id uuid, p_corretor_id uuid, p_direto boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_destino public.corretores;
  v_gestor text;
  v_anterior text;
  v_prazo_minutos integer;
  v_prazo timestamptz;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor pode passar o lead para outro corretor';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead não encontrado';
  end if;
  select * into v_destino from public.corretores where id = p_corretor_id and ativo;
  if not found then
    raise exception 'Corretor não encontrado ou inativo';
  end if;
  if not p_direto and v_destino.whatsapp is null then
    raise exception '% não tem WhatsApp no cadastro para receber o aviso', v_destino.nome;
  end if;

  select nome into v_gestor from public.corretores where id = interno.meu_corretor_id();
  select c.nome into v_anterior
  from public.corretores c
  where c.id = coalesce(
    v_lead.corretor_id,
    (select a.corretor_id from public.atribuicoes a where a.lead_id = p_lead_id and a.status = 'pendente' limit 1)
  );

  update public.atribuicoes set status = 'cancelada', respondida_em = now()
  where lead_id = p_lead_id and status = 'pendente';

  if p_direto then
    -- Já nasce aceita: o gatilho do aviso só dispara para oferta pendente.
    insert into public.atribuicoes (lead_id, corretor_id, prazo_em, motivo, status, respondida_em)
    values (p_lead_id, p_corretor_id, now(), 'gestor', 'aceita', now());
    update public.leads set corretor_id = p_corretor_id, status = 'com_corretor', ia_ativa = false
    where id = p_lead_id;
  else
    select (valor #>> '{}')::integer into v_prazo_minutos from public.configuracoes where chave = 'prazo_rodizio_minutos';
    v_prazo := now() + make_interval(mins => coalesce(v_prazo_minutos, 30));
    update public.leads set corretor_id = null, status = 'aguardando_corretor' where id = p_lead_id;
    insert into public.atribuicoes (lead_id, corretor_id, prazo_em, motivo)
    values (p_lead_id, p_corretor_id, v_prazo, 'gestor');
  end if;

  insert into public.mensagens (lead_id, autor, conteudo)
  values (
    p_lead_id, 'sistema',
    format('%s passou o lead%s para %s%s',
      coalesce(v_gestor, 'O gestor'),
      case when v_anterior is not null and v_anterior <> v_destino.nome then ' de ' || v_anterior else '' end,
      v_destino.nome,
      case when p_direto then ', atribuído direto' else ', que recebeu o aviso para assumir' end)
  );

  return jsonb_build_object(
    'situacao', case when p_direto then 'atribuido' else 'oferecido' end,
    'corretor_nome', v_destino.nome,
    'prazo_em', v_prazo
  );
end;
$$;

revoke execute on function public.passar_lead(uuid, uuid, boolean) from public, anon;
grant execute on function public.passar_lead(uuid, uuid, boolean) to authenticated;
