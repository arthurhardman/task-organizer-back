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
    const emailLower = email.toLowerCase();

    // Verificar se email já está cadastrado
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [emailLower]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    // Verificar se existe convite pendente para este email
    const invitationResult = await pool.query(
      `SELECT bi.business_id, bi.id as invitation_id, b.max_users, b.extra_users_count
       FROM business_invitations bi
       INNER JOIN businesses b ON b.id = bi.business_id
       WHERE bi.email = $1`,
      [emailLower]
    );

    let businessId: number | null = null;
    let isAdmin = false;
    let isBusiness = false;
    let isPremium = false;

    if (invitationResult.rows.length > 0) {
      // Usuário tem convite - associar ao business
      const invitation = invitationResult.rows[0];
      businessId = invitation.business_id;

      // Verificar se business tem plano business ativo (tem admin com is_business = true)
      const adminCheck = await pool.query(
        'SELECT id FROM users WHERE business_id = $1 AND is_business = TRUE AND is_admin = TRUE',
        [businessId]
      );

      if (adminCheck.rows.length === 0) {
        // Não há admin com plano business - não pode registrar ainda
        return res.status(403).json({ 
          error: 'Este email foi convidado, mas a empresa ainda não possui um plano Business ativo. Entre em contato com o administrador.' 
        });
      }

      // Verificar se há subscription ativa do business
      const subscriptionCheck = await pool.query(
        `SELECT s.id 
         FROM subscriptions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE u.business_id = $1 AND u.is_business = TRUE AND s.status = 'active'
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [businessId]
      );

      // Se a empresa tem plano business ativo, o usuário também recebe acesso premium e business
      if (subscriptionCheck.rows.length > 0) {
        isBusiness = true;
        isPremium = true;
      }

      // Contar usuários atuais do business
      const userCountResult = await pool.query(
        'SELECT COUNT(*) FROM users WHERE business_id = $1',
        [businessId]
      );
      const currentUserCount = parseInt(userCountResult.rows[0].count);
      const maxUsers = invitation.max_users || 20;
      const extraUsers = invitation.extra_users_count || 0;
      const totalAllowed = maxUsers + extraUsers;

      if (currentUserCount >= totalAllowed) {
        return res.status(403).json({ 
          error: `Limite de usuários atingido (${totalAllowed}). Entre em contato com o administrador para adicionar mais usuários.` 
        });
      }

      // Não é admin - apenas usuário normal
      isAdmin = false;
    } else {
      // Sem convite - criar usuário sem business
      businessId = null;
      isAdmin = false;
      isBusiness = false;
      isPremium = false;
    }

    // Criar usuário
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, credits, business_id, is_admin, is_business, is_premium) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, name, business_id, is_admin, is_business, is_premium',
      [emailLower, hashedPassword, name, 25, businessId, isAdmin, isBusiness, isPremium] // 25 créditos iniciais
    );

    const user = result.rows[0];

    // Se foi associado a um business via convite, remover o convite e adicionar ao histórico se necessário
    if (invitationResult.rows.length > 0 && businessId) {
      // Remover convite
      await pool.query('DELETE FROM business_invitations WHERE id = $1', [invitationResult.rows[0].invitation_id]);

      // Verificar se precisa adicionar ao histórico de usuários extras
      const userCountResult = await pool.query(
        'SELECT COUNT(*) FROM users WHERE business_id = $1',
        [businessId]
      );
      const currentUserCount = parseInt(userCountResult.rows[0].count);
      const maxUsers = invitationResult.rows[0].max_users || 20;
      const extraUsers = invitationResult.rows[0].extra_users_count || 0;

      if (currentUserCount > maxUsers && currentUserCount > maxUsers + extraUsers) {
        // Buscar subscription ativa
        const subscriptionResult = await pool.query(
          `SELECT expires_at, created_at 
           FROM subscriptions s
           INNER JOIN users u ON u.id = s.user_id
           WHERE u.business_id = $1 AND u.is_business = TRUE AND s.status = 'active'
           ORDER BY s.created_at DESC
           LIMIT 1`,
          [businessId]
        );

        let periodStart = new Date();
        let periodEnd = new Date();
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        if (subscriptionResult.rows.length > 0) {
          const sub = subscriptionResult.rows[0];
          periodStart = new Date(sub.created_at);
          periodEnd = sub.expires_at ? new Date(sub.expires_at) : periodEnd;
        }

        // Adicionar ao histórico de usuários extras
        await pool.query(
          `INSERT INTO extra_users_history (business_id, user_id, cost, subscription_period_start, subscription_period_end, charged)
           VALUES ($1, $2, $3, $4, $5, FALSE)`,
          [businessId, user.id, 15.00, periodStart, periodEnd]
        );
      }
    }

    const secret = process.env.JWT_SECRET || 'default-secret-change-in-production';
    const token = jwt.sign(
      { userId: user.id },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as jwt.SignOptions
    );

    // Garantir que se for business, também seja premium
    if (user.is_business && !user.is_premium) {
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [user.id]);
      user.is_premium = true;
    }

    res.status(201).json({ 
      user: {
        ...user,
        isPremium: user.is_premium || user.is_business || false,
        language: 'pt',
        credits: 25,
        isAdmin: user.is_admin || false,
        isBusiness: user.is_business || false,
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
    let isPremium = await updateUserPremiumStatus(user.id);
    
    // Garantir que se for business, também seja premium
    if (user.is_business && !isPremium) {
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [user.id]);
      isPremium = true;
    }
    
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
        isPremium: isPremium || user.is_business || false,
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
    let isPremium = await updateUserPremiumStatus(authReq.userId);
    
    // Buscar dados do usuário
    const result = await pool.query(
      'SELECT id, email, name, language, business_id, is_admin, is_business, is_premium FROM users WHERE id = $1',
      [authReq.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = result.rows[0];
    
    // Garantir que se for business, também seja premium
    if (user.is_business && !user.is_premium) {
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [authReq.userId]);
      isPremium = true;
    }
    
    // Inicializar créditos se necessário
    await initializeCredits(authReq.userId);
    const credits = await getUserCredits(authReq.userId);

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      isPremium: isPremium || user.is_business || false,
      language: user.language,
      credits: credits,
      isAdmin: user.is_admin || false,
      isBusiness: user.is_business || false,
      businessId: user.business_id || null,
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

