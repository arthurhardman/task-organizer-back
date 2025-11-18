import { Response, NextFunction } from 'express';
import { pool } from '../db';
import { AuthRequest } from './auth';

// Middleware para verificar se tem acesso business (is_business OU is_admin)
export const requireBusinessAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await pool.query(
      'SELECT is_admin, is_business, business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = result.rows[0];

    // Admin tem acesso a tudo (mesmo sem business_id)
    if (user.is_admin) {
      req.businessId = user.business_id;
      return next();
    }

    // Verificar se tem plano business
    if (!user.is_business) {
      return res.status(403).json({ 
        error: 'Acesso negado. É necessário ter um plano Business para acessar esta funcionalidade.' 
      });
    }

    // Se não tem business_id mas tem is_business, pode ser um problema
    // Mas vamos permitir e deixar as rotas lidarem com isso
    req.businessId = user.business_id;
    next();
  } catch (error) {
    console.error('Error checking business access:', error);
    res.status(500).json({ error: 'Erro ao verificar permissões' });
  }
};

