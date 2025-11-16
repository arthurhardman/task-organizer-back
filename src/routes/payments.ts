import express from 'express';
import axios from 'axios';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

const GGCHECKOUT_API_URL = process.env.GGCHECKOUT_API_URL || 'https://api.ggcheckout.com';
const GGCHECKOUT_API_KEY = process.env.GGCHECKOUT_API_KEY || '';

// Create checkout session
router.post('/create-checkout', authenticate, async (req: AuthRequest, res) => {
  try {
    const { installments = 1 } = req.body;
    const amount = 25000; // R$ 250.00 em centavos

    // Buscar dados do usuário
    const userResult = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];

    // Criar pedido no GGCheckout
    const checkoutData = {
      product_id: process.env.GGCHECKOUT_PRODUCT_ID || '',
      customer_email: user.email,
      customer_name: user.name,
      amount: amount,
      currency: 'BRL',
      installments: installments,
      return_url: `${process.env.FRONTEND_URL}/payment/success`,
      cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
      metadata: {
        user_id: req.userId!.toString(),
        installments: installments.toString(),
      },
    };

    const response = await axios.post(
      `${GGCHECKOUT_API_URL}/api/v1/checkout/create`,
      checkoutData,
      {
        headers: {
          'Authorization': `Bearer ${GGCHECKOUT_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Salvar referência do checkout no banco
    await pool.query(
      `INSERT INTO subscriptions (user_id, ggcheckout_checkout_id, status, amount, installments)
       VALUES ($1, $2, 'pending', $3, $4)
       ON CONFLICT (ggcheckout_checkout_id) DO NOTHING`,
      [
        req.userId,
        response.data.checkout_id,
        amount,
        installments,
      ]
    );

    res.json({
      checkout_url: response.data.checkout_url,
      checkout_id: response.data.checkout_id,
    });
  } catch (error: any) {
    console.error('GGCheckout error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erro ao criar checkout',
      details: error.response?.data || error.message,
    });
  }
});

// Webhook handler
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const { event, data } = req.body;

    // Verificar assinatura do webhook (se GGCheckout fornecer)
    const webhookSecret = process.env.GGCHECKOUT_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-ggcheckout-signature'];
      // Implementar verificação de assinatura se necessário
    }

    if (event === 'payment.completed' || event === 'payment.approved') {
      const checkoutId = data.checkout_id || data.id;
      const userId = data.metadata?.user_id;

      if (!userId || !checkoutId) {
        return res.status(400).json({ error: 'Dados incompletos' });
      }

      try {
        // Atualizar usuário para premium
        await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [userId]);

        // Atualizar status da subscription
        await pool.query(
          `UPDATE subscriptions 
           SET status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE ggcheckout_checkout_id = $1`,
          [checkoutId]
        );
      } catch (error) {
        console.error('Error updating subscription:', error);
        return res.status(500).json({ error: 'Erro ao atualizar assinatura' });
      }
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Erro ao processar webhook' });
  }
});

// Verify payment status
router.get('/verify/:checkoutId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { checkoutId } = req.params;

    // Verificar status no GGCheckout
    const response = await axios.get(
      `${GGCHECKOUT_API_URL}/api/v1/checkout/${checkoutId}`,
      {
        headers: {
          'Authorization': `Bearer ${GGCHECKOUT_API_KEY}`,
        },
      }
    );

    const status = response.data.status;

    if (status === 'completed' || status === 'approved') {
      // Atualizar usuário para premium
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [req.userId]);

      // Atualizar subscription
      await pool.query(
        `UPDATE subscriptions 
         SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE ggcheckout_checkout_id = $1 AND user_id = $2`,
        [checkoutId, req.userId]
      );
    }

    res.json({
      status,
      checkout: response.data,
    });
  } catch (error: any) {
    console.error('Verify payment error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Erro ao verificar pagamento' });
  }
});

// Get subscription status
router.get('/status', authenticate, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.is_premium
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [req.userId]
    );

    const userResult = await pool.query(
      'SELECT is_premium FROM users WHERE id = $1',
      [req.userId]
    );

    res.json({
      isPremium: userResult.rows[0]?.is_premium || false,
      subscription: result.rows[0] || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

export { router as paymentRoutes };
