-- O gestor também envia e troca a foto de perfil de qualquer pessoa da equipe.
create policy "Gestor envia foto de perfil da equipe" on storage.objects
  for insert to authenticated with check (bucket_id = 'perfis' and (select interno.sou_gestor()));
create policy "Gestor apaga foto de perfil da equipe" on storage.objects
  for delete to authenticated using (bucket_id = 'perfis' and (select interno.sou_gestor()));

create function public.gestor_definir_foto(p_id uuid, p_foto_url text)
returns public.corretores
language plpgsql security definer set search_path = ''
as $$
declare
  v_foto text := nullif(trim(coalesce(p_foto_url, '')), '');
  v_pessoa public.corretores;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor muda a foto de outra pessoa';
  end if;
  if v_foto is not null and v_foto not like '%/storage/v1/object/public/perfis/' || p_id::text || '/%' then
    raise exception 'Foto inválida';
  end if;
  update public.corretores c set foto_url = v_foto where c.id = p_id returning * into v_pessoa;
  if not found then
    raise exception 'Pessoa não encontrada';
  end if;
  return v_pessoa;
end;
$$;
revoke all on function public.gestor_definir_foto(uuid, text) from public, anon;
grant execute on function public.gestor_definir_foto(uuid, text) to authenticated;
