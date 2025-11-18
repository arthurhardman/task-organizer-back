import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

// Middleware para verificar se é admin
const requireAdmin = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  try {
    const result = await pool.query(
      'SELECT is_admin, business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores podem realizar esta ação.' });
    }

    req.businessId = result.rows[0].business_id;
    next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Erro ao verificar permissões' });
  }
};

// Get business info
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.name, b.domain, b.created_at
       FROM businesses b
       INNER JOIN users u ON u.business_id = b.id
       WHERE u.id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({ error: 'Erro ao buscar informações da empresa' });
  }
});

// Get all teams for the business
router.get('/teams', authenticate, async (req: AuthRequest, res) => {
  try {
    // Obter business_id do usuário
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_id) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const businessId = userResult.rows[0].business_id;

    const result = await pool.query(
      `SELECT t.id, t.name, t.description, t.created_at,
              COUNT(tm.id) as member_count
       FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE t.business_id = $1
       GROUP BY t.id
       ORDER BY t.created_at ASC`,
      [businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Erro ao buscar equipes' });
  }
});

// Create team (apenas admin)
router.post('/teams', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome da equipe é obrigatório' });
    }

    const result = await pool.query(
      'INSERT INTO teams (business_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [req.businessId, name, description || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Erro ao criar equipe' });
  }
});

// Update team (apenas admin)
router.put('/teams/:id', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    // Verificar se a equipe pertence ao business do admin
    const teamCheck = await pool.query(
      'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Equipe não encontrada' });
    }

    const result = await pool.query(
      'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [name, description, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(500).json({ error: 'Erro ao atualizar equipe' });
  }
});

// Delete team (apenas admin)
router.delete('/teams/:id', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Verificar se a equipe pertence ao business do admin
    const teamCheck = await pool.query(
      'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Equipe não encontrada' });
    }

    await pool.query('DELETE FROM teams WHERE id = $1', [id]);

    res.json({ message: 'Equipe excluída com sucesso' });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(500).json({ error: 'Erro ao excluir equipe' });
  }
});

// Get team members
router.get('/teams/:id/members', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Verificar se a equipe pertence ao business do usuário
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_id) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const businessId = userResult.rows[0].business_id;

    const teamCheck = await pool.query(
      'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
      [id, businessId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Equipe não encontrada' });
    }

    const result = await pool.query(
      `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.created_at,
              u.name, u.email
       FROM team_members tm
       INNER JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.created_at ASC`,
      [id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Erro ao buscar membros da equipe' });
  }
});

// Add member to team (apenas admin)
router.post('/teams/:id/members', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { user_id, role } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'ID do usuário é obrigatório' });
    }

    // Verificar se a equipe pertence ao business do admin
    const teamCheck = await pool.query(
      'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Equipe não encontrada' });
    }

    // Verificar se o usuário pertence ao mesmo business
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND business_id = $2',
      [user_id, req.businessId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Usuário não pertence à mesma empresa' });
    }

    const result = await pool.query(
      'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO UPDATE SET role = $3 RETURNING *',
      [id, user_id, role || 'member']
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Usuário já é membro desta equipe' });
    }
    console.error('Error adding team member:', error);
    res.status(500).json({ error: 'Erro ao adicionar membro à equipe' });
  }
});

// Remove member from team (apenas admin)
router.delete('/teams/:id/members/:userId', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id, userId } = req.params;

    // Verificar se a equipe pertence ao business do admin
    const teamCheck = await pool.query(
      'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Equipe não encontrada' });
    }

    await pool.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [id, userId]
    );

    res.json({ message: 'Membro removido da equipe com sucesso' });
  } catch (error) {
    console.error('Error removing team member:', error);
    res.status(500).json({ error: 'Erro ao remover membro da equipe' });
  }
});

// Get all users in the business (para adicionar a equipes)
router.get('/users', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.is_admin,
              COUNT(DISTINCT tm.team_id) as team_count
       FROM users u
       LEFT JOIN team_members tm ON tm.user_id = u.id
       WHERE u.business_id = $1
       GROUP BY u.id
       ORDER BY u.name ASC`,
      [req.businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching business users:', error);
    res.status(500).json({ error: 'Erro ao buscar usuários da empresa' });
  }
});

export default router;

