-- Remover constraint UNIQUE que impede múltiplas colunas com o mesmo status
-- Permite que usuários criem múltiplas colunas com o mesmo status_id

DO $$ 
BEGIN
  -- Verificar se a constraint existe antes de tentar removê-la
  IF EXISTS (
    SELECT 1 
    FROM pg_constraint 
    WHERE conname = 'kanban_columns_user_id_status_id_key'
  ) THEN
    ALTER TABLE kanban_columns 
    DROP CONSTRAINT kanban_columns_user_id_status_id_key;
    
    RAISE NOTICE 'Constraint UNIQUE removida com sucesso';
  ELSE
    RAISE NOTICE 'Constraint UNIQUE não encontrada (pode já ter sido removida)';
  END IF;
END $$;

