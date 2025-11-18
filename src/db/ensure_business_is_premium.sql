-- Trigger para garantir que usuários business sempre sejam premium
-- Execute este script no banco de dados

-- Função que garante que is_business = TRUE implica is_premium = TRUE
CREATE OR REPLACE FUNCTION ensure_business_is_premium()
RETURNS TRIGGER AS $$
BEGIN
  -- Se o usuário é business, garantir que também seja premium
  IF NEW.is_business = TRUE AND (NEW.is_premium IS NULL OR NEW.is_premium = FALSE) THEN
    NEW.is_premium := TRUE;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Criar trigger antes de INSERT ou UPDATE na tabela users
DROP TRIGGER IF EXISTS trigger_ensure_business_is_premium ON users;
CREATE TRIGGER trigger_ensure_business_is_premium
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION ensure_business_is_premium();

-- Corrigir dados existentes: garantir que todos os usuários business sejam premium
UPDATE users 
SET is_premium = TRUE 
WHERE is_business = TRUE AND (is_premium IS NULL OR is_premium = FALSE);

