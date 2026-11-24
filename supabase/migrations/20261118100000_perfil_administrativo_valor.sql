-- Novo perfil da equipe: administrativo (acesso de gestor, menos criar acessos,
-- site e disparos). Fica numa migração separada: o valor novo do enum só pode
-- ser usado depois que esta transação termina.
alter type public.equipe_papel add value if not exists 'administrativo';
