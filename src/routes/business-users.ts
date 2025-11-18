import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireBusinessAccess } from '../middleware/business';

const router = express.Router();

// Middleware para verificar se é admin
const requireAdmin = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  try {
    const result = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem realizar esta ação.' });
    }

    next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Erro ao verificar permissões' });
  }
};

// Get all users in the business (admin only)
router.get('/users', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (!req.businessId) {
      const userResult = await pool.query(
        'SELECT business_id FROM users WHERE id = $1',
        [req.userId]
      );
      req.businessId = userResult.rows[0]?.business_id;
    }

    if (!req.businessId) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_admin, u.is_business, u.created_at,
              COUNT(DISTINCT tm.team_id) as team_count
       FROM users u
       LEFT JOIN team_members tm ON tm.user_id = u.id
       WHERE u.business_id = $1
       GROUP BY u.id
       ORDER BY u.created_at ASC`,
      [req.businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching business users:', error);
    res.status(500).json({ error: 'Erro ao buscar usuários da empresa' });
  }
});

// Get business info with user count
router.get('/info', authenticate, requireBusinessAccess, async (req: AuthRequest, res) => {
  try {
    if (!req.businessId) {
      const userResult = await pool.query(
        'SELECT business_id FROM users WHERE id = $1',
        [req.userId]
      );
      req.businessId = userResult.rows[0]?.business_id;
    }

    if (!req.businessId) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    // Buscar informações do business
    const businessResult = await pool.query(
      'SELECT id, name, domain, max_users, extra_users_count, created_at FROM businesses WHERE id = $1',
      [req.businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ error: 'Business não encontrado' });
    }

    const business = businessResult.rows[0];

    // Contar usuários atuais
    const userCountResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE business_id = $1',
      [req.businessId]
    );
    const currentUserCount = parseInt(userCountResult.rows[0].count);

    // Calcular custo de usuários extras
    const maxUsers = business.max_users || 20;
    const extraUsers = business.extra_users_count || 0;
    const totalAllowed = maxUsers + extraUsers;
    const usersOverLimit = currentUserCount > maxUsers ? currentUserCount - maxUsers : 0;
    const extraUsersNeeded = usersOverLimit > extraUsers ? usersOverLimit - extraUsers : 0;
    const extraUsersCost = extraUsersNeeded * 15; // R$ 15 por usuário extra

    res.json({
      ...business,
      currentUserCount,
      totalAllowed,
      usersOverLimit,
      extraUsersNeeded,
      extraUsersCost,
      canAddMore: currentUserCount < totalAllowed,
    });
  } catch (error) {
    console.error('Error fetching business info:', error);
    res.status(500).json({ error: 'Erro ao buscar informações da empresa' });
  }
});

// Add extra users (apenas admin)
router.post('/users/add-extra', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { extraUsersCount } = req.body;

    if (!extraUsersCount || extraUsersCount < 1) {
      return res.status(400).json({ error: 'Número de usuários extras inválido' });
    }

    if (!req.businessId) {
      const userResult = await pool.query(
        'SELECT business_id FROM users WHERE id = $1',
        [req.userId]
      );
      req.businessId = userResult.rows[0]?.business_id;
    }

    if (!req.businessId) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    // Atualizar contagem de usuários extras
    const result = await pool.query(
      'UPDATE businesses SET extra_users_count = extra_users_count + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [extraUsersCount, req.businessId]
    );

    const cost = extraUsersCount * 15; // R$ 15 por usuário

    res.json({
      ...result.rows[0],
      addedUsers: extraUsersCount,
      cost,
      message: `${extraUsersCount} usuário(s) extra adicionado(s). Custo: R$ ${cost.toFixed(2)}`,
    });
  } catch (error) {
    console.error('Error adding extra users:', error);
    res.status(500).json({ error: 'Erro ao adicionar usuários extras' });
  }
});

// Remove user from business (apenas admin)
router.delete('/users/:userId', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;

    if (!req.businessId) {
      const userResult = await pool.query(
        'SELECT business_id FROM users WHERE id = $1',
        [req.userId]
      );
      req.businessId = userResult.rows[0]?.business_id;
    }

    if (!req.businessId) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    // Verificar se o usuário pertence ao business
    const userCheck = await pool.query(
      'SELECT id, is_admin FROM users WHERE id = $1 AND business_id = $2',
      [userId, req.businessId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado ou não pertence à empresa' });
    }

    // Não permitir remover o próprio admin
    if (parseInt(userId) === req.userId) {
      return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
    }

    // Não permitir remover outro admin
    if (userCheck.rows[0].is_admin) {
      return res.status(400).json({ error: 'Não é possível remover outro administrador' });
    }

    // Remover usuário (cascade vai remover team_members, tasks, etc)
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    res.json({ message: 'Usuário removido da empresa com sucesso' });
  } catch (error) {
    console.error('Error removing user:', error);
    res.status(500).json({ error: 'Erro ao remover usuário' });
  }
});

export default router;

