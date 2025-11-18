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
// Se admin não for business, retorna todos os usuários do sistema
router.get('/users', authenticate, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Verificar se é admin e se tem business
    const userResult = await pool.query(
      'SELECT is_business, business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const currentUser = userResult.rows[0];
    const isBusiness = currentUser.is_business || false;
    const businessId = currentUser.business_id;

    // Se for admin mas não for business, retornar todos os usuários do sistema
    if (!isBusiness) {
      const result = await pool.query(
        `SELECT u.id, u.name, u.email, u.is_admin, u.is_business, u.created_at, u.business_id,
                b.name as business_name,
                COUNT(DISTINCT tm.team_id) as team_count
         FROM users u
         LEFT JOIN businesses b ON b.id = u.business_id
         LEFT JOIN team_members tm ON tm.user_id = u.id
         GROUP BY u.id, b.name
         ORDER BY u.created_at ASC`
      );

      return res.json(result.rows);
    }

    // Se for admin com business, retornar apenas usuários da empresa
    if (!businessId) {
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
      [businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching business users:', error);
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

// Get business info with user count
// Se admin não for business, retorna informações gerais do sistema
router.get('/info', authenticate, async (req: AuthRequest, res) => {
  try {
    // Verificar se é admin e se tem business
    const userResult = await pool.query(
      'SELECT is_admin, is_business, business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const currentUser = userResult.rows[0];
    
    // Se for admin mas não for business, retornar informações gerais do sistema
    if (!currentUser.is_business) {
      // Contar todos os usuários do sistema
      const totalUsersResult = await pool.query('SELECT COUNT(*) FROM users');
      const totalUsers = parseInt(totalUsersResult.rows[0].count);

      // Contar empresas
      const totalBusinessesResult = await pool.query('SELECT COUNT(*) FROM businesses');
      const totalBusinesses = parseInt(totalBusinessesResult.rows[0].count);

      return res.json({
        id: null,
        name: 'Sistema',
        domain: 'sistema',
        max_users: null,
        extra_users_count: null,
        currentUserCount: totalUsers,
        totalAllowed: null,
        usersOverLimit: 0,
        extraUsersNeeded: 0,
        extraUsersCost: 0,
        canAddMore: true,
        isSystemAdmin: true,
        totalBusinesses,
      });
    }

    // Se for admin com business, retornar informações da empresa
    const businessId = currentUser.business_id;
    if (!businessId) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    // Buscar informações do business
    const businessResult = await pool.query(
      'SELECT id, name, domain, max_users, extra_users_count, created_at FROM businesses WHERE id = $1',
      [businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ error: 'Business não encontrado' });
    }

    const business = businessResult.rows[0];

    // Contar usuários atuais
    const userCountResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE business_id = $1',
      [businessId]
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
      isSystemAdmin: false,
    });
  } catch (error) {
    console.error('Error fetching business info:', error);
    res.status(500).json({ error: 'Erro ao buscar informações' });
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

// Cadastrar usuário por email (apenas admin)
router.post('/users/invite', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido' });
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

    // Verificar se email já está cadastrado como usuário no business
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND business_id = $2',
      [email.toLowerCase(), req.businessId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Este email já está cadastrado na empresa' });
    }

    // Verificar se já existe convite pendente
    const existingInvite = await pool.query(
      'SELECT id FROM business_invitations WHERE business_id = $1 AND email = $2',
      [req.businessId, email.toLowerCase()]
    );

    if (existingInvite.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe um convite pendente para este email' });
    }

    // Buscar informações do business para verificar limite
    const businessResult = await pool.query(
      'SELECT max_users, extra_users_count FROM businesses WHERE id = $1',
      [req.businessId]
    );

    if (businessResult.rows.length === 0) {
      return res.status(404).json({ error: 'Business não encontrado' });
    }

    const business = businessResult.rows[0];
    const maxUsers = business.max_users || 20;
    const extraUsers = business.extra_users_count || 0;
    const totalAllowed = maxUsers + extraUsers;

    // Contar usuários atuais + convites pendentes
    const userCountResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE business_id = $1',
      [req.businessId]
    );
    const currentUserCount = parseInt(userCountResult.rows[0].count);

    const inviteCountResult = await pool.query(
      'SELECT COUNT(*) FROM business_invitations WHERE business_id = $1',
      [req.businessId]
    );
    const pendingInvites = parseInt(inviteCountResult.rows[0].count);

    const totalUsers = currentUserCount + pendingInvites;

    if (totalUsers >= totalAllowed) {
      return res.status(403).json({ 
        error: `Limite de usuários atingido (${totalAllowed}). Adicione mais usuários extras para convidar novos usuários.` 
      });
    }

    // Criar convite
    const inviteResult = await pool.query(
      'INSERT INTO business_invitations (business_id, email, invited_by) VALUES ($1, $2, $3) RETURNING *',
      [req.businessId, email.toLowerCase(), req.userId]
    );

    // Se o total de usuários (incluindo convites) ultrapassar o limite base (20), registrar no histórico
    const usersOverBase = totalUsers > maxUsers ? totalUsers - maxUsers : 0;
    if (usersOverBase > extraUsers) {
      // Buscar subscription ativa do business para pegar período
      const subscriptionResult = await pool.query(
        `SELECT expires_at, created_at 
         FROM subscriptions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE u.business_id = $1 AND u.is_business = TRUE AND s.status = 'active'
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [req.businessId]
      );

      let periodStart = new Date();
      let periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      if (subscriptionResult.rows.length > 0) {
        const sub = subscriptionResult.rows[0];
        periodStart = new Date(sub.created_at);
        periodEnd = sub.expires_at ? new Date(sub.expires_at) : periodEnd;
      }

      // Quando o usuário se registrar, será adicionado ao histórico
      // Por enquanto, apenas criamos o convite
    }

    res.status(201).json({
      message: 'Convite enviado com sucesso. O usuário poderá se registrar com este email.',
      invitation: inviteResult.rows[0],
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Já existe um convite para este email' });
    }
    console.error('Error inviting user:', error);
    res.status(500).json({ error: 'Erro ao convidar usuário' });
  }
});

// Listar convites pendentes (apenas admin)
router.get('/users/invitations', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
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
      `SELECT bi.id, bi.email, bi.created_at, u.name as invited_by_name
       FROM business_invitations bi
       LEFT JOIN users u ON u.id = bi.invited_by
       WHERE bi.business_id = $1
       ORDER BY bi.created_at DESC`,
      [req.businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ error: 'Erro ao buscar convites' });
  }
});

// Remover convite pendente (apenas admin)
router.delete('/users/invitations/:id', authenticate, requireBusinessAccess, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

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

    // Verificar se o convite pertence ao business
    const inviteCheck = await pool.query(
      'SELECT id FROM business_invitations WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (inviteCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Convite não encontrado' });
    }

    await pool.query('DELETE FROM business_invitations WHERE id = $1', [id]);

    res.json({ message: 'Convite removido com sucesso' });
  } catch (error) {
    console.error('Error removing invitation:', error);
    res.status(500).json({ error: 'Erro ao remover convite' });
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

