-- O papel da equipe é do tipo equipe_papel: a função de gestão converte o texto recebido.
do $$
begin
  execute replace(pg_get_functiondef('public.gestor_atualizar_pessoa'::regproc), 'papel = p_papel,', 'papel = p_papel::public.equipe_papel,');
end $$;
