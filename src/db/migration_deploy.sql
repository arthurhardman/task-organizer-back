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

-- 7. Criar tabela para colunas personalizadas do Kanban
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

-- Criar índices para melhor performance
CREATE INDEX IF NOT EXISTS idx_kanban_columns_user_id ON kanban_columns(user_id);
CREATE INDEX IF NOT EXISTS idx_kanban_columns_position ON kanban_columns(user_id, position);

-- 8. Sistema de Business, Equipes e Chamados
-- Criar tabela de businesses (empresas)
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Adicionar campos de controle de usuários (se não existirem)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'max_users') THEN
    ALTER TABLE businesses ADD COLUMN max_users INTEGER DEFAULT 20;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'extra_users_count') THEN
    ALTER TABLE businesses ADD COLUMN extra_users_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- Adicionar business_id, is_admin e is_business na tabela users (se não existirem)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_id') THEN
    ALTER TABLE users ADD COLUMN business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_admin') THEN
    ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_business') THEN
    ALTER TABLE users ADD COLUMN is_business BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Criar tabela de teams (equipes)
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_teams_business_id ON teams(business_id);

-- Criar tabela de team_members (membros das equipes)
CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) DEFAULT 'member',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);

-- Criar tabela de tickets (chamados)
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'open',
  priority VARCHAR(50) DEFAULT 'medium',
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_business_id ON tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team_id ON tickets(assigned_team_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

-- Adicionar campos na tabela tasks para suportar chamados (se não existirem)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'ticket_id') THEN
    ALTER TABLE tasks ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_ticket_id ON tasks(ticket_id);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'started_at') THEN
    ALTER TABLE tasks ADD COLUMN started_at TIMESTAMP;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'assigned_to') THEN
    ALTER TABLE tasks ADD COLUMN assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
  END IF;
END $$;

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

