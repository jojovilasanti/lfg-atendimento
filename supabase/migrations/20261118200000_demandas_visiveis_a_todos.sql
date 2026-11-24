-- Decisão do gestor (18/11): toda a equipe vê as demandas de todos.
-- Continua igual: só o gestor passa demanda para outra pessoa; o responsável
-- muda o status; quem criou (e o gestor) edita e exclui.
drop policy if exists "Vê as próprias demandas; o gestor vê todas" on public.demandas;
create policy "Equipe vê todas as demandas" on public.demandas for select to authenticated
  using ((select interno.meu_corretor_id()) is not null);
