-- O administrativo também aparece em "Nossa equipe" no site (pedido do gestor).
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.site_dados'::regproc) into v_def;
  v_def := replace(v_def, 'where r.ativo and r.papel <> ''administrativo''', 'where r.ativo');
  if v_def like '%r.papel <> ''administrativo''%' then
    raise exception 'site_dados: filtro do administrativo não saiu';
  end if;
  execute v_def;
end $$;
