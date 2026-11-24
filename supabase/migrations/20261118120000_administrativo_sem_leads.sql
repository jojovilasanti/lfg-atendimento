-- O administrativo não acompanha atendimentos: não vê nem mexe em leads,
-- conversas, histórico, próximos passos dos leads e leads dos portais.
-- Continua vendo o Plantão (quem está de plantão e a fila do rodízio), mas sem
-- os dados dos leads.

create or replace function interno.posso_ver_lead(p_lead_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select interno.sou_gestor_pleno()
    or exists (
      select 1 from public.leads l
      where l.id = p_lead_id and l.corretor_id = interno.meu_corretor_id()
    )
    or exists (
      select 1 from public.atribuicoes a
      where a.lead_id = p_lead_id and a.status = 'pendente' and a.corretor_id = interno.meu_corretor_id()
    );
$function$;

create or replace function interno.posso_editar_lead(p_lead_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select interno.sou_gestor_pleno() or exists (
    select 1 from public.leads l where l.id = p_lead_id and l.corretor_id = interno.meu_corretor_id()
  );
$function$;

drop policy if exists "Gestor vê os leads dos portais" on public.leads_portais;
create policy "Gestor vê os leads dos portais" on public.leads_portais for select to authenticated
  using ((select interno.sou_gestor_pleno()));

-- Ações nos leads que liberavam a gestão inteira passam a liberar só o gestor.
do $$
declare v_def text;
begin
  for v_def in
    select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('criar_cliente', 'editar_cliente', 'finalizar_lead', 'mudar_etapa', 'passar_lead',
                        'registrar_atividade', 'definir_ia_do_lead', 'criar_tarefa')
  loop
    execute replace(v_def, 'interno.sou_gestor()', 'interno.sou_gestor_pleno()');
  end loop;
end $$;
