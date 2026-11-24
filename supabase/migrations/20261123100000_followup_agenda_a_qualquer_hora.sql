-- Follow-up: a conversa parada passa a ser registrada a qualquer hora
-- (noite e fim de semana). Antes, o registro só acontecia no horário comercial
-- e a trava de 24h descartava quem parou na sexta à noite ou no fim de semana.
-- As mensagens continuam saindo só no horário comercial.

create or replace function interno.processar_followup(p_incluir_testes boolean default false)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_cfg jsonb := (select c.valor from public.configuracoes c where c.chave = 'followup');
  v_lead record;
  v_etapa integer;
  v_total integer := 0;
  v_pode_enviar boolean := interno.no_comercial(now());
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'ativo')::boolean, false) then
    return 0;
  end if;

  for v_lead in
    select l.id, l.followup_etapa, l.followup_proximo, u.criado_em as ultima_em
    from public.leads l
    cross join lateral (
      select m.autor, m.criado_em from public.mensagens m
      where m.lead_id = l.id and m.autor <> 'sistema'
      order by m.criado_em desc, m.id desc limit 1
    ) u
    where l.status = 'em_atendimento_ia' and l.ia_ativa
      and (p_incluir_testes or l.whatsapp not like 'sim-%')
      and u.autor = 'ia'
      and l.followup_etapa < 5
      and exists (select 1 from public.mensagens c where c.lead_id = l.id and c.autor = 'cliente')
    for update of l skip locked
  loop
    -- Registrar a conversa parada: a qualquer hora.
    if v_lead.followup_proximo is null then
      continue when v_lead.ultima_em < now() - interval '24 hours';
      update public.leads set followup_proximo = interno.agendar_followup(v_lead.ultima_em, v_cfg -> 'passos' -> 0)
      where id = v_lead.id;
      continue;
    end if;

    -- Enviar: só no horário comercial.
    continue when not v_pode_enviar or now() < v_lead.followup_proximo;

    v_etapa := v_lead.followup_etapa + 1;
    insert into public.mensagens (lead_id, autor, tipo, conteudo, status_entrega, followup_n)
    values (v_lead.id, 'ia', 'followup', v_cfg -> 'mensagens' ->> (v_etapa - 1), 'pendente', v_etapa);
    v_total := v_total + 1;

    if v_etapa >= 5 then
      update public.leads
      set etapa = 'perdido', status = 'encerrado', ia_ativa = false, motivo_perda = 'Sem resposta do cliente'
      where id = v_lead.id;
      insert into public.mensagens (lead_id, autor, conteudo)
      values (v_lead.id, 'sistema', 'Atendimento finalizado automaticamente: sem resposta do cliente depois de 5 mensagens de follow-up.');
    else
      update public.leads
      set followup_etapa = v_etapa,
          followup_proximo = interno.agendar_followup(now(), v_cfg -> 'passos' -> v_etapa)
      where id = v_lead.id;
    end if;
  end loop;
  return v_total;
end;
$function$;
