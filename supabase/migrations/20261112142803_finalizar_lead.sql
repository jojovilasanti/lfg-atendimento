-- "Finalizar cliente": encerra o atendimento de quem não tem interesse (ou não é
-- cliente). O corretor do lead finaliza os dele; o gestor finaliza qualquer um,
-- inclusive os que ainda estão com a IA. Se o cliente voltar a escrever, o lead
-- reabre sozinho (interno.reabrir_ao_escrever).
create function public.finalizar_lead(p_lead_id uuid, p_motivo text)
returns public.leads
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_motivo text := nullif(trim(coalesce(p_motivo, '')), '');
  v_quem text;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead não encontrado';
  end if;
  if not interno.sou_gestor() and (v_lead.corretor_id is null or v_lead.corretor_id <> interno.meu_corretor_id()) then
    raise exception 'Só o corretor do lead ou o gestor podem finalizar o atendimento';
  end if;
  if v_motivo is null then
    raise exception 'Escolha o motivo para finalizar';
  end if;
  if v_lead.status = 'encerrado' then
    raise exception 'Este atendimento já está finalizado';
  end if;

  update public.atribuicoes set status = 'cancelada' where lead_id = p_lead_id and status = 'pendente';
  update public.tarefas set concluida_em = now() where lead_id = p_lead_id and concluida_em is null;
  update public.leads
  set etapa = 'perdido', status = 'encerrado', ia_ativa = false, motivo_perda = left(v_motivo, 200), valor_negocio = null
  where id = p_lead_id
  returning * into v_lead;

  select c.nome into v_quem from public.corretores c where c.id = interno.meu_corretor_id();
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', format('%s finalizou o atendimento: %s', coalesce(v_quem, 'A equipe'), left(v_motivo, 200)));
  return v_lead;
end;
$$;
revoke all on function public.finalizar_lead(uuid, text) from public, anon;
grant execute on function public.finalizar_lead(uuid, text) to authenticated;
