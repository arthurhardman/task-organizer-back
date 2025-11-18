import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

// Get all tickets for the business
router.get('/', authenticate, async (req: AuthRequest, res) => {
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
      `SELECT t.id, t.title, t.description, t.status, t.priority, 
              t.created_at, t.updated_at, t.started_at, t.resolved_at,
              t.assigned_team_id, t.assigned_to, t.task_id,
              creator.name as created_by_name, creator.email as created_by_email,
              team.name as team_name,
              assignee.name as assigned_to_name,
              task.status as task_status
       FROM tickets t
       INNER JOIN users creator ON creator.id = t.created_by
       LEFT JOIN teams team ON team.id = t.assigned_team_id
       LEFT JOIN users assignee ON assignee.id = t.assigned_to
       LEFT JOIN tasks task ON task.id = t.task_id
       WHERE t.business_id = $1
       ORDER BY t.created_at DESC`,
      [businessId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Erro ao buscar chamados' });
  }
});

// Get ticket by ID
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

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
      `SELECT t.*, 
              creator.name as created_by_name, creator.email as created_by_email,
              team.name as team_name,
              assignee.name as assigned_to_name
       FROM tickets t
       INNER JOIN users creator ON creator.id = t.created_by
       LEFT JOIN teams team ON team.id = t.assigned_team_id
       LEFT JOIN users assignee ON assignee.id = t.assigned_to
       WHERE t.id = $1 AND t.business_id = $2`,
      [id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ error: 'Erro ao buscar chamado' });
  }
});

// Create ticket
router.post('/', authenticate, async (req: AuthRequest, res) => {
  const client = await pool.connect();
  try {
    const { title, description, assigned_team_id, priority } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Título do chamado é obrigatório' });
    }

    // Obter business_id do usuário
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_id) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const businessId = userResult.rows[0].business_id;

    // Verificar se a equipe pertence ao business
    if (assigned_team_id) {
      const teamCheck = await pool.query(
        'SELECT id FROM teams WHERE id = $1 AND business_id = $2',
        [assigned_team_id, businessId]
      );

      if (teamCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Equipe não encontrada ou não pertence à empresa' });
      }
    }

    await client.query('BEGIN');

    try {
      // Criar o ticket
      const ticketResult = await client.query(
        `INSERT INTO tickets (business_id, created_by, assigned_team_id, title, description, priority, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'open')
         RETURNING *`,
        [businessId, req.userId, assigned_team_id || null, title, description || null, priority || 'medium']
      );

      const ticket = ticketResult.rows[0];

      // Se houver equipe atribuída, criar tarefa automaticamente
      if (assigned_team_id) {
        // Buscar primeiro membro da equipe (ou usar o criador do ticket como fallback)
        const firstUserResult = await client.query(
          `SELECT u.id FROM users u
           INNER JOIN team_members tm ON tm.user_id = u.id
           WHERE tm.team_id = $1
           ORDER BY tm.created_at ASC
           LIMIT 1`,
          [assigned_team_id]
        );

        const taskOwnerId = firstUserResult.rows.length > 0 
          ? firstUserResult.rows[0].id 
          : req.userId;

        // Buscar primeira coluna do Kanban (menor position) - sempre usar a primeira coluna
        const firstColumnResult = await client.query(
          'SELECT status_id FROM kanban_columns WHERE user_id = $1 ORDER BY position ASC LIMIT 1',
          [taskOwnerId]
        );

        // Se não houver colunas, usar TODO como padrão
        const defaultStatus = firstColumnResult.rows.length > 0 
          ? firstColumnResult.rows[0].status_id 
          : 'TODO';

        // Criar tarefa automaticamente na primeira coluna do Kanban
        // started_at será definido quando a equipe assumir o chamado
        const taskResult = await client.query(
          `INSERT INTO tasks (user_id, title, description, status, priority, ticket_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           RETURNING *`,
          [taskOwnerId, `[Chamado] ${title}`, description || null, defaultStatus, priority || 'medium', ticket.id]
        );

        const task = taskResult.rows[0];

        // Atualizar ticket com task_id
        await client.query(
          'UPDATE tickets SET task_id = $1 WHERE id = $2',
          [task.id, ticket.id]
        );

        ticket.task_id = task.id;
      }

      await client.query('COMMIT');
      res.status(201).json(ticket);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Erro ao criar chamado' });
  } finally {
    client.release();
  }
});

// Update ticket (atribuir responsável, mudar status, etc)
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { assigned_to, status, priority } = req.body;

    // Obter business_id do usuário
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_id) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const businessId = userResult.rows[0].business_id;

    // Verificar se o ticket pertence ao business
    const ticketCheck = await pool.query(
      'SELECT id, assigned_team_id FROM tickets WHERE id = $1 AND business_id = $2',
      [id, businessId]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado' });
    }

    const ticket = ticketCheck.rows[0];

    // Se estiver atribuindo responsável, verificar se pertence à equipe
    if (assigned_to && ticket.assigned_team_id) {
      const memberCheck = await pool.query(
        'SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2',
        [ticket.assigned_team_id, assigned_to]
      );

      if (memberCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Usuário não pertence à equipe atribuída' });
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (assigned_to !== undefined) {
      updates.push(`assigned_to = $${paramIndex++}`);
      values.push(assigned_to);
      
      // Se está atribuindo pela primeira vez, definir started_at
      const ticketCheckResult = await pool.query(
        'SELECT started_at FROM tickets WHERE id = $1',
        [id]
      );
      
      if (ticketCheckResult.rows.length > 0 && !ticketCheckResult.rows[0].started_at) {
        updates.push(`started_at = CURRENT_TIMESTAMP`);
        
        // Atualizar started_at da tarefa também
        const taskUpdateResult = await pool.query(
          'SELECT task_id FROM tickets WHERE id = $1',
          [id]
        );
        if (taskUpdateResult.rows.length > 0 && taskUpdateResult.rows[0].task_id) {
          await pool.query(
            'UPDATE tasks SET started_at = CURRENT_TIMESTAMP WHERE id = $1',
            [taskUpdateResult.rows[0].task_id]
          );
        }
      }
    }

    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
      
      // Se está resolvendo, definir resolved_at
      if (status === 'resolved' || status === 'closed') {
        updates.push(`resolved_at = CURRENT_TIMESTAMP`);
      }
    }

    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex++}`);
      values.push(priority);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE tickets 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex++}
       RETURNING *`,
      values
    );

    // Se mudou o responsável, atualizar a tarefa também
    if (assigned_to && result.rows[0].task_id) {
      await pool.query(
        'UPDATE tasks SET assigned_to = $1 WHERE id = $2',
        [assigned_to, result.rows[0].task_id]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Erro ao atualizar chamado' });
  }
});

// Delete ticket
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Obter business_id do usuário
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_id) {
      return res.status(404).json({ error: 'Usuário não está associado a uma empresa' });
    }

    const businessId = userResult.rows[0].business_id;

    // Verificar se o ticket pertence ao business e foi criado pelo usuário ou é admin
    const ticketCheck = await pool.query(
      `SELECT t.id, t.created_by, u.is_admin 
       FROM tickets t
       INNER JOIN users u ON u.id = $1
       WHERE t.id = $2 AND t.business_id = $3`,
      [req.userId, id, businessId]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado' });
    }

    const ticket = ticketCheck.rows[0];
    const isAdmin = ticketCheck.rows[0].is_admin;

    // Só pode deletar se for o criador ou admin
    if (ticket.created_by !== req.userId && !isAdmin) {
      return res.status(403).json({ error: 'Apenas o criador ou administrador pode excluir o chamado' });
    }

    await pool.query('DELETE FROM tickets WHERE id = $1', [id]);

    res.json({ message: 'Chamado excluído com sucesso' });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({ error: 'Erro ao excluir chamado' });
  }
});

export default router;

