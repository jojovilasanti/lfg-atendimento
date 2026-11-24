-- Impressão digital dos dados do site: o gerador na VPS confere a cada minuto
-- e só baixa tudo (uns 400 KB) quando algo mudou.
create or replace function public.site_versao()
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select md5(public.site_dados()::text);
$function$;

revoke all on function public.site_versao() from public;
grant execute on function public.site_versao() to anon, authenticated;
