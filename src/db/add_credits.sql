-- Script para adicionar coluna credits na tabela users
-- Execute este script no seu banco de dados Neon se a tabela já existir

ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 25;

-- Inicializar créditos para usuários existentes sem créditos
UPDATE users SET credits = 25 WHERE credits IS NULL;

