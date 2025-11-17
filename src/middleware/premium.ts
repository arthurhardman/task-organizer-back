import { Response, NextFunction } from 'express';
import { pool } from '../db';
import { AuthRequest } from './auth';

/**
 * Middleware para verificar se o usuário é premium
 */
export const requirePremium = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const result = await pool.query(
      'SELECT is_premium FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (!result.rows[0].is_premium) {
      return res.status(403).json({ 
        error: 'Recurso exclusivo para usuários Premium',
        message: 'Faça upgrade para Premium para acessar este recurso'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking premium status:', error);
    res.status(500).json({ error: 'Erro ao verificar status premium' });
  }
};

