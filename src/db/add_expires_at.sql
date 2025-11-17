-- Script para adicionar coluna expires_at na tabela subscriptions
-- Execute este script no seu banco de dados Neon se a tabela já existir

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- Atualizar subscriptions existentes sem expires_at para 1 mês a partir de created_at
UPDATE subscriptions 
SET expires_at = created_at + INTERVAL '1 month'
WHERE expires_at IS NULL AND status = 'active';

