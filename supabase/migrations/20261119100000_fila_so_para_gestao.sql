-- O corretor não vê a fila completa do rodízio: a função devolve a ele só o
-- próximo da vez. Gestor e administrativo continuam vendo a fila inteira.
-- O rodízio em si (interno.fila_do_rodizio, oferecer_lead) não muda.
create or replace function public.fila_do_rodizio()
 returns table (corretor_id uuid, posicao integer, ultimo_lead timestamptz, recebidos_hoje integer, oferta_ate timestamptz)
 language sql
 stable security definer
 set search_path to ''
as $$
  select f.corretor_id, f.posicao, f.ultimo_lead, f.recebidos_hoje,
    (select min(a.prazo_em) from public.atribuicoes a where a.corretor_id = f.corretor_id and a.status = 'pendente')
  from interno.fila_do_rodizio(null) f
  where interno.meu_corretor_id() is not null
  order by f.posicao
  limit case when interno.sou_gestor() then null else 1 end;
$$;
