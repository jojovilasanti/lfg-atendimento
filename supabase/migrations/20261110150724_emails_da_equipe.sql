-- O gestor vê o e-mail de acesso de cada pessoa da equipe (fica em auth.users).
create function public.emails_da_equipe()
returns table (corretor_id uuid, email text, ultimo_acesso timestamptz)
language plpgsql security definer set search_path = ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor vê os e-mails da equipe';
  end if;
  return query
    select c.id, u.email::text, u.last_sign_in_at
    from public.corretores c
    join auth.users u on u.id = c.usuario_id;
end;
$$;
revoke all on function public.emails_da_equipe() from public, anon;
grant execute on function public.emails_da_equipe() to authenticated;
