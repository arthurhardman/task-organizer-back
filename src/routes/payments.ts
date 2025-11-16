import express from 'express';
import axios from 'axios';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = express.Router();

const GGCHECKOUT_API_URL = process.env.GGCHECKOUT_API_URL || 'https://api.ggcheckout.com';
const GGCHECKOUT_API_KEY = process.env.GGCHECKOUT_API_KEY || '';

// Get checkout URL
router.get('/checkout-url', authenticate, async (req: AuthRequest, res) => {
  try {
    // Link direto do GGCheckout
    const checkoutUrl = 'https://www.ggcheckout.com/checkout/v2/RNCPqNAHkEGRn21iIW2s';
    
    res.json({
      checkout_url: checkoutUrl,
    });
  } catch (error: any) {
    console.error('Error getting checkout URL:', error);
    res.status(500).json({
      error: 'Erro ao obter URL do checkout',
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
