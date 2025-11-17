import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

// Colunas padrão do Kanban
const DEFAULT_COLUMNS = [
  { name: 'A Fazer', status_id: 'todo', position: 0, color: '#3b82f6' },
  { name: 'Em Progresso', status_id: 'inProgress', position: 1, color: '#eab308' },
  { name: 'Concluída', status_id: 'done', position: 2, color: '#22c55e' },
];

// Inicializar colunas padrão para um usuário
async function initializeDefaultColumns(userId: number) {
  try {
    // Verificar se o usuário já tem colunas
    const existingColumns = await pool.query(
      'SELECT COUNT(*) FROM kanban_columns WHERE user_id = $1',
      [userId]
    );

    if (parseInt(existingColumns.rows[0].count) === 0) {
      // Inserir colunas padrão
      for (const column of DEFAULT_COLUMNS) {
        await pool.query(
          `INSERT INTO kanban_columns (user_id, name, status_id, position, color)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, status_id) DO NOTHING`,
          [userId, column.name, column.status_id, column.position, column.color]
        );
      }
    }
  } catch (error) {
    console.error('Error initializing default columns:', error);
  }
}

// Get all columns for the authenticated user
router.get('/columns', authenticate, async (req: AuthRequest, res) => {
  try {
    // Garantir que o usuário tenha colunas padrão
    await initializeDefaultColumns(req.userId!);

    const result = await pool.query(
      'SELECT * FROM kanban_columns WHERE user_id = $1 ORDER BY position ASC',
      [req.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching kanban columns:', error);
    res.status(500).json({ error: 'Erro ao buscar colunas do Kanban' });
  }
});

// Create a new column
router.post('/columns', authenticate, async (req: AuthRequest, res) => {
  try {
    const { name, status_id, position, color } = req.body;

    if (!name || !status_id) {
      return res.status(400).json({ error: 'Nome e status_id são obrigatórios' });
    }

    // Verificar se já existe uma coluna com esse status_id para o usuário
    const existing = await pool.query(
      'SELECT id FROM kanban_columns WHERE user_id = $1 AND status_id = $2',
      [req.userId, status_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma coluna com esse status_id' });
    }

    const result = await pool.query(
      `INSERT INTO kanban_columns (user_id, name, status_id, position, color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        req.userId,
        name,
        status_id,
        position ?? 0,
        color || '#3b82f6',
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating kanban column:', error);
    res.status(500).json({ error: 'Erro ao criar coluna do Kanban' });
  }
});

// Update a column
router.put('/columns/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { name, position, color } = req.body;
    const columnId = parseInt(req.params.id);

    // Verificar se a coluna pertence ao usuário
    const existing = await pool.query(
      'SELECT id FROM kanban_columns WHERE id = $1 AND user_id = $2',
      [columnId, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Coluna não encontrada' });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position);
    }
    if (color !== undefined) {
      updates.push(`color = $${paramIndex++}`);
      values.push(color);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(columnId, req.userId);

    const result = await pool.query(
      `UPDATE kanban_columns 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex++} AND user_id = $${paramIndex++}
       RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating kanban column:', error);
    res.status(500).json({ error: 'Erro ao atualizar coluna do Kanban' });
  }
});

// Delete a column
router.delete('/columns/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const columnId = parseInt(req.params.id);

    // Verificar se a coluna pertence ao usuário
    const existing = await pool.query(
      'SELECT id, status_id FROM kanban_columns WHERE id = $1 AND user_id = $2',
      [columnId, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Coluna não encontrada' });
    }

    const statusId = existing.rows[0].status_id;

    // Verificar se há tarefas usando esse status
    const tasksCount = await pool.query(
      'SELECT COUNT(*) FROM tasks WHERE user_id = $1 AND status = $2',
      [req.userId, statusId]
    );

    if (parseInt(tasksCount.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Não é possível excluir a coluna. Existem tarefas usando este status.' 
      });
    }

    await pool.query(
      'DELETE FROM kanban_columns WHERE id = $1 AND user_id = $2',
      [columnId, req.userId]
    );

    res.json({ message: 'Coluna excluída com sucesso' });
  } catch (error) {
    console.error('Error deleting kanban column:', error);
    res.status(500).json({ error: 'Erro ao excluir coluna do Kanban' });
  }
});

// Reorder columns (update positions)
router.put('/columns/reorder', authenticate, async (req: AuthRequest, res) => {
  try {
    const { columns } = req.body; // Array de { id, position }

    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Colunas devem ser um array' });
    }

    // Atualizar posições em uma transação
    await pool.query('BEGIN');

    try {
      for (const column of columns) {
        await pool.query(
          'UPDATE kanban_columns SET position = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3',
          [column.position, column.id, req.userId]
        );
      }

      await pool.query('COMMIT');
      res.json({ message: 'Ordem das colunas atualizada com sucesso' });
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error reordering kanban columns:', error);
    res.status(500).json({ error: 'Erro ao reordenar colunas do Kanban' });
  }
});

export default router;

