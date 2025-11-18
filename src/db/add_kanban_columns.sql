-- Migration: Adicionar tabela para colunas personalizadas do Kanban
-- Execute este script no banco de dados (Neon)

CREATE TABLE IF NOT EXISTS kanban_columns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  status_id VARCHAR(50) NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color VARCHAR(20) DEFAULT '#3b82f6',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- Removida constraint UNIQUE(user_id, status_id) para permitir múltiplas colunas com o mesmo status
);

-- Remover constraint UNIQUE se existir (para bancos já criados)
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 
    FROM pg_constraint 
    WHERE conname = 'kanban_columns_user_id_status_id_key'
  ) THEN
    ALTER TABLE kanban_columns 
    DROP CONSTRAINT kanban_columns_user_id_status_id_key;
  END IF;
END $$;

-- Criar índice para melhor performance
CREATE INDEX IF NOT EXISTS idx_kanban_columns_user_id ON kanban_columns(user_id);
CREATE INDEX IF NOT EXISTS idx_kanban_columns_position ON kanban_columns(user_id, position);

-- Inserir colunas padrão para usuários existentes (se não tiverem colunas)
-- Isso será feito via backend quando o usuário acessar o Kanban pela primeira vez

