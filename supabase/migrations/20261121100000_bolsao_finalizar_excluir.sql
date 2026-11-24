-- Bolsão: gestor e administrativo finalizam ou excluem um lead sem mandar
-- nenhuma mensagem ao cliente (nem o pedido de avaliação).
--   * Finalizar: vai para os finalizados, motivo "Finalizado pelo gestor no bolsão".
--   * Excluir: exclusão lógica. Some de todas as listas do painel (a regra de
--     leitura esconde), mas fica no banco com quem excluiu e quando.
-- Se o cliente de um lead excluído escrever de novo, ele volta como atendimento
-- novo (igual ao finalizado), para a mensagem não ficar sem ninguém ver.

alter table public.leads add column if not exists excluido_em timestamptz;
alter table public.leads add column if not exists excluido_por uuid references public.corretores (id) on delete set null;
comment on column public.leads.excluido_em is 'Exclusão lógica (pelo gestor, no bolsão): o lead some do painel mas continua no banco.';

drop policy if exists "Equipe vê os leads permitidos" on public.leads;
create policy "Equipe vê os leads permitidos" on public.leads for select to authenticated
  using (excluido_em is null and interno.posso_ver_lead(id));

-- Esses dois motivos nunca recebem o pedido de avaliação.
update public.configuracoes
set valor = jsonb_set(valor, '{motivos_sem_avaliacao}',
  (select jsonb_agg(distinct m) from jsonb_array_elements_text(
     coalesce(valor -> 'motivos_sem_avaliacao', '[]'::jsonb) || '["Finalizado pelo gestor no bolsão", "Excluído pelo gestor no bolsão"]'::jsonb) m))
where chave = 'avaliacao';

create or replace function interno.tirar_do_bolsao(p_lead_id uuid, p_excluir boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu public.corretores;
  v_lead public.leads;
  v_motivo text := case when p_excluir then 'Excluído pelo gestor no bolsão' else 'Finalizado pelo gestor no bolsão' end;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo finalizam ou excluem leads do bolsão';
  end if;
  select * into v_eu from public.corretores where id = interno.meu_corretor_id();
  update public.leads
  set status = 'encerrado', etapa = 'perdido', ia_ativa = false, corretor_id = null,
      motivo_perda = v_motivo, valor_negocio = null,
      excluido_em = case when p_excluir then now() end,
      excluido_por = case when p_excluir then v_eu.id end
  where id = p_lead_id and status = 'aguardando_corretor' and bolsao_desde is not null
  returning * into v_lead;
  if v_lead.id is null then
    raise exception 'Este lead não está mais no bolsão';
  end if;
  update public.atribuicoes set status = 'cancelada', respondida_em = now() where lead_id = p_lead_id and status = 'pendente';
  update public.tarefas set concluida_em = now() where lead_id = p_lead_id and concluida_em is null;
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', format('%s %s o lead do bolsão em %s, sem mensagem ao cliente',
    coalesce(v_eu.nome, 'A gestão'), case when p_excluir then 'excluiu' else 'finalizou' end,
    to_char(now() at time zone interno.fuso(), 'DD/MM/YYYY "às" HH24:MI')));
  return jsonb_build_object('ok', true, 'lead_id', p_lead_id, 'acao', case when p_excluir then 'excluido' else 'finalizado' end);
end;
$$;

create or replace function public.finalizar_do_bolsao(p_lead_id uuid)
 returns jsonb language sql security definer set search_path to ''
as $$ select interno.tirar_do_bolsao(p_lead_id, false); $$;
create or replace function public.excluir_do_bolsao(p_lead_id uuid)
 returns jsonb language sql security definer set search_path to ''
as $$ select interno.tirar_do_bolsao(p_lead_id, true); $$;
revoke all on function public.finalizar_do_bolsao(uuid) from public, anon;
revoke all on function public.excluir_do_bolsao(uuid) from public, anon;
grant execute on function public.finalizar_do_bolsao(uuid) to authenticated;
grant execute on function public.excluir_do_bolsao(uuid) to authenticated;

-- Cliente de lead excluído que escreve de novo: volta como atendimento novo.
do $$
declare v_def text;
begin
  select pg_get_functiondef('interno.reabrir_ao_escrever'::regproc) into v_def;
  v_def := replace(v_def, 'motivo_perda = null, valor_negocio = null
    where id = v_lead.id;', 'motivo_perda = null, valor_negocio = null, excluido_em = null, excluido_por = null
    where id = v_lead.id;');
  if v_def not like '%excluido_em = null%' then raise exception 'reabrir_ao_escrever: trecho não encontrado'; end if;
  execute v_def;
end $$;
