-- ============================================
-- CORREÇÃO: Alterar tipo do campo amount
-- Execute este script se o campo amount ainda for INTEGER
-- ============================================

-- Alterar tipo do campo amount de INTEGER para NUMERIC para suportar valores decimais
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
    
    RAISE NOTICE 'Campo amount alterado de INTEGER para NUMERIC(10,2) com sucesso!';
  ELSE
    RAISE NOTICE 'Campo amount já é NUMERIC ou não existe. Nenhuma alteração necessária.';
  END IF;
END $$;

-- Verificar o tipo do campo após a alteração
SELECT column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns 
WHERE table_name = 'subscriptions' AND column_name = 'amount';

