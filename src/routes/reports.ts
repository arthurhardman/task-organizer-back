import express from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePremium } from '../middleware/premium';

const router = express.Router();

/**
 * Relatório mensal - apenas para premium
 * GET /api/reports/monthly?year=2025&month=11
 */
router.get('/monthly', authenticate, requirePremium, async (req: AuthRequest, res) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;

    // Validar mês e ano
    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Mês inválido' });
    }

    if (year < 2020 || year > 2100) {
      return res.status(400).json({ error: 'Ano inválido' });
    }

    // Calcular início e fim do mês
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    // Buscar todas as tarefas do mês
    const tasksResult = await pool.query(
      `SELECT 
        id,
        title,
        status,
        priority,
        due_date,
        created_at,
        updated_at
       FROM tasks
       WHERE user_id = $1
       AND created_at >= $2
       AND created_at <= $3
       ORDER BY created_at ASC`,
      [req.userId, startDate, endDate]
    );

    const tasks = tasksResult.rows;

    // Estatísticas gerais
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'done').length;
    const pendingTasks = tasks.filter(t => t.status !== 'done').length;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Estatísticas por status
    const statusStats = {
      todo: tasks.filter(t => t.status === 'todo').length,
      inProgress: tasks.filter(t => t.status === 'inProgress').length,
      done: tasks.filter(t => t.status === 'done').length,
    };

    // Estatísticas por prioridade
    const priorityStats = {
      high: tasks.filter(t => t.priority === 'high').length,
      medium: tasks.filter(t => t.priority === 'medium').length,
      low: tasks.filter(t => t.priority === 'low').length,
    };

    // Tarefas criadas por dia do mês
    const tasksByDay: { [key: number]: number } = {};
    tasks.forEach(task => {
      const day = new Date(task.created_at).getDate();
      tasksByDay[day] = (tasksByDay[day] || 0) + 1;
    });

    // Tarefas concluídas por dia do mês
    const completedByDay: { [key: number]: number } = {};
    tasks
      .filter(t => t.status === 'done')
      .forEach(task => {
        const day = new Date(task.updated_at).getDate();
        completedByDay[day] = (completedByDay[day] || 0) + 1;
      });

    // Tarefas com data de vencimento
    const tasksWithDueDate = tasks.filter(t => t.due_date);
    const overdueTasks = tasksWithDueDate.filter(t => {
      const dueDate = new Date(t.due_date);
      return dueDate < new Date() && t.status !== 'done';
    }).length;

    // Média de tarefas por dia
    const daysInMonth = new Date(year, month, 0).getDate();
    const avgTasksPerDay = totalTasks > 0 ? (totalTasks / daysInMonth).toFixed(2) : '0.00';

    // Tarefas mais recentes (últimas 10)
    const recentTasks = tasks
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10)
      .map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        createdAt: t.created_at,
      }));

    res.json({
      period: {
        year,
        month,
        monthName: new Date(year, month - 1).toLocaleString('pt-BR', { month: 'long' }),
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      summary: {
        totalTasks,
        completedTasks,
        pendingTasks,
        completionRate,
        overdueTasks,
        avgTasksPerDay: parseFloat(avgTasksPerDay),
      },
      statusStats,
      priorityStats,
      tasksByDay,
      completedByDay,
      recentTasks,
    });
  } catch (error) {
    console.error('Error generating monthly report:', error);
    res.status(500).json({ error: 'Erro ao gerar relatório mensal' });
  }
});

export { router as reportRoutes };

