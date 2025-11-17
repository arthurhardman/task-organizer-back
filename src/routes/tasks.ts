import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { hasEnoughCredits, consumeCredits } from '../utils/credits';

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
    const { title, description, status, priority, due_date, due_time } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }

    // Verificar e consumir créditos
    const hasCredits = await hasEnoughCredits(req.userId!);
    if (!hasCredits) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para criar uma tarefa. Faça upgrade para Premium ou aguarde a renovação de créditos.'
      });
    }

    const creditResult = await consumeCredits(req.userId!);
    if (!creditResult.success) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para criar uma tarefa.',
        remaining: creditResult.remaining
      });
    }

    const result = await pool.query(
      `INSERT INTO tasks (user_id, title, description, status, priority, due_date, due_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.userId,
        title,
        description || null,
        status || 'todo',
        priority || 'medium',
        due_date || null,
        due_time || null,
      ]
    );

    res.status(201).json({
      ...result.rows[0],
      creditsRemaining: creditResult.remaining,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

// Update task
router.put('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { title, description, status, priority, due_date, due_time, position } = req.body;

    // Verificar e consumir créditos (apenas se não for premium)
    const hasCredits = await hasEnoughCredits(req.userId!);
    if (!hasCredits) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para editar uma tarefa.'
      });
    }

    const creditResult = await consumeCredits(req.userId!);
    if (!creditResult.success) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para editar uma tarefa.',
        remaining: creditResult.remaining
      });
    }

    const result = await pool.query(
      `UPDATE tasks
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           priority = COALESCE($4, priority),
           due_date = COALESCE($5, due_date),
           due_time = COALESCE($6, due_time),
           position = COALESCE($7, position),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [
        title,
        description,
        status,
        priority,
        due_date,
        due_time,
        position,
        req.params.id,
        req.userId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    res.json({
      ...result.rows[0],
      creditsRemaining: creditResult.remaining,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// Delete task
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    // Verificar e consumir créditos (apenas se não for premium)
    const hasCredits = await hasEnoughCredits(req.userId!);
    if (!hasCredits) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para deletar uma tarefa.'
      });
    }

    const creditResult = await consumeCredits(req.userId!);
    if (!creditResult.success) {
      return res.status(403).json({ 
        error: 'Créditos insuficientes',
        message: 'Você não tem créditos suficientes para deletar uma tarefa.',
        remaining: creditResult.remaining
      });
    }

    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarefa não encontrada' });
    }

    res.json({ 
      message: 'Tarefa deletada com sucesso',
      creditsRemaining: creditResult.remaining,
    });
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

