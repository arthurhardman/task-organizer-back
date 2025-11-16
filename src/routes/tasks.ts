import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

// Get all tasks
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE user_id = $1 ORDER BY position ASC, created_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar tarefas' });
  }
});

// Get task by id
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar tarefa' });
  }
});

// Create task
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { title, description, status, priority, due_date } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }

    const result = await pool.query(
      `INSERT INTO tasks (user_id, title, description, status, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.userId,
        title,
        description || null,
        status || 'todo',
        priority || 'medium',
        due_date || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// Update task
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { title, description, status, priority, due_date, position } = req.body;

    const result = await pool.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           priority = COALESCE($4, priority),
           due_date = COALESCE($5, due_date),
           position = COALESCE($6, position),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [
        title,
        description,
        status,
        priority,
        due_date,
        position,
        req.params.id,
        req.userId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// Delete task
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    res.json({ message: 'Tarefa deletada com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar tarefa' });
  }
});

// Get tasks by date range (for dashboard)
router.get('/dashboard/range', authenticate, async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Datas são obrigatórias' });
    }

    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE user_id = $1
       AND (due_date BETWEEN $2 AND $3 OR due_date IS NULL)
       ORDER BY due_date ASC, created_at DESC`,
      [req.userId, startDate, endDate]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar tarefas' });
  }
});

export { router as taskRoutes };

