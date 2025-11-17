-- ============================================
-- SCRIPT DE MIGRAÇÃO PARA DEPLOY
-- Execute este script no banco de dados cloud (Neon)
-- ============================================

-- 1. Adicionar coluna expires_at na tabela subscriptions (se não existir)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- 2. Adicionar coluna credits na tabela users (se não existir)
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 25;

-- 3. Inicializar créditos para usuários existentes sem créditos
UPDATE users SET credits = 25 WHERE credits IS NULL;

-- 4. Adicionar coluna due_time na tabela tasks (NOVA - para horário das tarefas)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time TIME;

-- 5. Alterar tipo do campo amount de INTEGER para NUMERIC para suportar valores decimais
-- Primeiro, converter dados existentes (multiplicar por 100 para manter centavos como inteiros temporariamente)
DO $$
BEGIN
  -- Verificar se o campo é INTEGER antes de alterar
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'subscriptions' 
    AND column_name = 'amount' 
    AND data_type = 'integer'
  ) THEN
    -- Converter valores existentes para centavos (multiplicar por 100)
    UPDATE subscriptions SET amount = amount * 100 WHERE amount IS NOT NULL;
    
    -- Alterar tipo para NUMERIC(10,2) para suportar valores decimais
    ALTER TABLE subscriptions ALTER COLUMN amount TYPE NUMERIC(10,2);
    
    -- Converter valores de volta para reais (dividir por 100)
    UPDATE subscriptions SET amount = amount / 100.0 WHERE amount IS NOT NULL;
  END IF;
END $$;

-- 6. Atualizar subscriptions existentes sem expires_at para 1 mês a partir de created_at
UPDATE subscriptions 
SET expires_at = created_at + INTERVAL '1 month'
WHERE expires_at IS NULL AND status = 'active';

-- ============================================
-- VERIFICAÇÃO (opcional - para confirmar que funcionou)
-- ============================================
-- Execute estas queries para verificar se as colunas foram criadas:

-- Verificar coluna expires_at
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'subscriptions' AND column_name = 'expires_at';

-- Verificar coluna credits
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'users' AND column_name = 'credits';

-- Verificar coluna due_time
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'tasks' AND column_name = 'due_time';

