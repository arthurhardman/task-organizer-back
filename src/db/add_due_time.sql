-- Adicionar coluna due_time na tabela tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time TIME;

