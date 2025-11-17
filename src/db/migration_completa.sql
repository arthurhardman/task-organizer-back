-- Script de migração completo para adicionar colunas faltantes
-- Execute este script no seu banco de dados Neon (produção)

-- 1. Adicionar coluna expires_at na tabela subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- 2. Adicionar coluna credits na tabela users
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 25;

-- 3. Inicializar créditos para usuários existentes sem créditos
UPDATE users SET credits = 25 WHERE credits IS NULL;

-- 4. Atualizar subscriptions existentes sem expires_at para 1 mês a partir de created_at
UPDATE subscriptions 
SET expires_at = created_at + INTERVAL '1 month'
WHERE expires_at IS NULL AND status = 'active';

-- Verificar se as colunas foram adicionadas corretamente
SELECT 
    column_name, 
    data_type, 
    column_default
FROM information_schema.columns 
WHERE table_name = 'subscriptions' AND column_name = 'expires_at'
UNION ALL
SELECT 
    column_name, 
    data_type, 
    column_default
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'credits';

