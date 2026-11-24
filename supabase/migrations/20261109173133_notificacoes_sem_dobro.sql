-- O mesmo navegador ativando as notificações num endereço novo do painel gera
-- outra inscrição; a antiga daquele aparelho sai, para não chegar em dobro.
create or replace function public.registrar_notificacoes(p_endpoint text, p_p256dh text, p_auth text, p_aparelho text default null)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_eu uuid := interno.meu_corretor_id();
begin
  if v_eu is null then
    raise exception 'Entre no painel para ativar as notificações';
  end if;
  insert into public.push_inscricoes (corretor_id, endpoint, p256dh, auth, aparelho)
  values (v_eu, p_endpoint, p_p256dh, p_auth, left(p_aparelho, 200))
  on conflict (endpoint) do update
    set corretor_id = excluded.corretor_id, p256dh = excluded.p256dh, auth = excluded.auth, aparelho = excluded.aparelho, criado_em = now();
  if p_aparelho is not null then
    delete from public.push_inscricoes
    where corretor_id = v_eu and aparelho = left(p_aparelho, 200) and endpoint <> p_endpoint;
  end if;
end;
$function$;
