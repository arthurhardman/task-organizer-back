-- Migration: Adicionar Razão Social e CNPJ na tabela businesses
-- Criar tabela de histórico de usuários extras

-- 1. Adicionar campos razao_social e cnpj na tabela businesses
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'razao_social') THEN
    ALTER TABLE businesses ADD COLUMN razao_social VARCHAR(255);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'cnpj') THEN
    ALTER TABLE businesses ADD COLUMN cnpj VARCHAR(18) UNIQUE;
  END IF;
END $$;

-- 2. Criar tabela de histórico de usuários extras
CREATE TABLE IF NOT EXISTS extra_users_history (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cost NUMERIC(10,2) DEFAULT 15.00, -- R$ 15 por usuário extra
  subscription_period_start TIMESTAMP, -- Início do período da assinatura quando o usuário foi adicionado
  subscription_period_end TIMESTAMP, -- Fim do período da assinatura quando o usuário foi adicionado
  charged BOOLEAN DEFAULT FALSE, -- Se já foi cobrado na renovação
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_extra_users_history_business_id ON extra_users_history(business_id);
CREATE INDEX IF NOT EXISTS idx_extra_users_history_user_id ON extra_users_history(user_id);
CREATE INDEX IF NOT EXISTS idx_extra_users_history_charged ON extra_users_history(charged);

-- 3. Criar tabela de convites de usuários (emails cadastrados mas ainda não registrados)
CREATE TABLE IF NOT EXISTS business_invitations (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(business_id, email)
);

CREATE INDEX IF NOT EXISTS idx_business_invitations_business_id ON business_invitations(business_id);
CREATE INDEX IF NOT EXISTS idx_business_invitations_email ON business_invitations(email);

