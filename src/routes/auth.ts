import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { authenticate } from '../middleware/auth';
import { updateUserPremiumStatus } from '../utils/subscription';
import { getUserCredits, initializeCredits } from '../utils/credits';

const router = express.Router();

// Função auxiliar para extrair domínio do email e criar/obter business
async function getOrCreateBusiness(email: string): Promise<number | null> {
  try {
    // Extrair domínio do email (tudo depois do @)
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return null;

    // Verificar se business já existe
    const existingBusiness = await pool.query(
      'SELECT id FROM businesses WHERE domain = $1',
      [domain]
    );

    if (existingBusiness.rows.length > 0) {
      return existingBusiness.rows[0].id;
    }

    // Criar novo business
    const newBusiness = await pool.query(
      'INSERT INTO businesses (name, domain, max_users) VALUES ($1, $2, 20) RETURNING id',
      [domain.split('.')[0] || domain, domain] // Usar primeira parte do domínio como nome
    );

    return newBusiness.rows[0].id;
  } catch (error) {
    console.error('Error getting/creating business:', error);
    return null;
  }
}

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Extrair domínio do email
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    // Verificar se business existe para este domínio
    const businessResult = await pool.query(
      'SELECT id, max_users, extra_users_count FROM businesses WHERE domain = $1',
      [domain]
    );

    let businessId: number | null = null;
    let isAdmin = false;

    if (businessResult.rows.length > 0) {
      // Business existe - verificar se tem plano business ativo
      const business = businessResult.rows[0];
      businessId = business.id;

      // Verificar se há admin com is_business = true neste business
      const adminCheck = await pool.query(
        'SELECT id FROM users WHERE business_id = $1 AND is_business = TRUE AND is_admin = TRUE',
        [businessId]
      );

      if (adminCheck.rows.length === 0) {
        // Não há admin com plano business - não pode registrar
        return res.status(403).json({ 
          error: 'Este domínio não possui um plano Business ativo. Entre em contato com o administrador da empresa.' 
        });
      }

      // Contar usuários atuais do business
      const userCountResult = await pool.query(
        'SELECT COUNT(*) FROM users WHERE business_id = $1',
        [businessId]
      );
      const currentUserCount = parseInt(userCountResult.rows[0].count);
      const maxUsers = business.max_users || 20;
      const extraUsers = business.extra_users_count || 0;
      const totalAllowed = maxUsers + extraUsers;

      if (currentUserCount >= totalAllowed) {
        return res.status(403).json({ 
          error: `Limite de usuários atingido (${totalAllowed}). Entre em contato com o administrador para adicionar mais usuários.` 
        });
      }

      // Não é admin - apenas usuário normal
      isAdmin = false;
    } else {
      // Business não existe - criar novo (mas não será admin a menos que compre business)
      const newBusiness = await pool.query(
        'INSERT INTO businesses (name, domain, max_users) VALUES ($1, $2, 20) RETURNING id',
        [domain.split('.')[0] || domain, domain]
      );
      businessId = newBusiness.rows[0].id;
      // Primeiro usuário do business novo (mas sem plano business ainda)
      isAdmin = false;
    }

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, credits, business_id, is_admin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, business_id, is_admin',
      [email, hashedPassword, name, 25, businessId, isAdmin] // 25 créditos iniciais
    );

    const user = result.rows[0];
    const secret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const token = jwt.sign(
      { userId: user.id },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as jwt.SignOptions
    );

    res.status(201).json({ 
      user: {
        ...user,
        isPremium: false,
        language: 'pt',
        credits: 25,
        isAdmin: user.is_admin,
        isBusiness: false,
        businessId: user.business_id,
      },
      token 
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, name, is_premium, language, business_id, is_admin, is_business FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = result.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Verificar e atualizar status premium baseado na assinatura
    const isPremium = await updateUserPremiumStatus(user.id);
    
    // Inicializar créditos se necessário
    await initializeCredits(user.id);
    const credits = await getUserCredits(user.id);

    const secret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const token = jwt.sign(
      { userId: user.id },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as jwt.SignOptions
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isPremium: isPremium,
        language: user.language,
        credits: credits,
        isAdmin: user.is_admin || false,
        isBusiness: user.is_business || false,
        businessId: user.business_id || null,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const authReq = req as any;
    
    // Verificar e atualizar status premium
    const isPremium = await updateUserPremiumStatus(authReq.userId);
    
    // Inicializar créditos se necessário
    await initializeCredits(authReq.userId);
    const credits = await getUserCredits(authReq.userId);
    
    const result = await pool.query(
      'SELECT id, email, name, language, business_id, is_admin, is_business FROM users WHERE id = $1',
      [authReq.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      id: result.rows[0].id,
      email: result.rows[0].email,
      name: result.rows[0].name,
      isPremium: isPremium,
      language: result.rows[0].language,
      credits: credits,
      isAdmin: result.rows[0].is_admin || false,
      isBusiness: result.rows[0].is_business || false,
      businessId: result.rows[0].business_id || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

// Update language
router.patch('/language', authenticate, async (req, res) => {
  try {
    const authReq = req as any;
    const { language } = req.body;

    if (!['pt', 'en', 'es'].includes(language)) {
      return res.status(400).json({ error: 'Idioma inválido' });
    }

    await pool.query('UPDATE users SET language = $1 WHERE id = $2', [
      language,
      authReq.userId,
    ]);

    res.json({ message: 'Idioma atualizado' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar idioma' });
  }
});

export { router as authRoutes };

