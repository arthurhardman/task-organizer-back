import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { authenticate } from '../middleware/auth';
import { updateUserPremiumStatus } from '../utils/subscription';
import { getUserCredits, initializeCredits } from '../utils/credits';

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name, credits) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
      [email, hashedPassword, name, 25] // 25 créditos iniciais
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
      },
      token 
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }
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
      'SELECT id, email, password_hash, name, is_premium, language FROM users WHERE email = $1',
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
      'SELECT id, email, name, language FROM users WHERE id = $1',
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

