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

    console.log('Webhook recebido:', { event, data });

    // Verificar assinatura do webhook (se GGCheckout fornecer)
    const webhookSecret = process.env.GGCHECKOUT_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-ggcheckout-signature'];
      // TODO: Implementar verificação de assinatura se GGCheckout fornecer
      // if (signature !== expectedSignature) {
      //   return res.status(401).json({ error: 'Assinatura inválida' });
      // }
    }

    if (event === 'payment.completed' || event === 'payment.approved' || event === 'checkout.completed') {
      const checkoutId = data.checkout_id || data.id || data.checkout_id;
      const userId = data.metadata?.user_id;
      const customerEmail = data.customer?.email || data.email || data.customer_email;

      console.log('Processando pagamento:', { checkoutId, userId, customerEmail });

      // Tentar identificar o usuário
      let targetUserId = userId;

      // Se não tiver user_id no metadata, tentar buscar pelo email
      if (!targetUserId && customerEmail) {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE email = $1',
          [customerEmail]
        );
        if (userResult.rows.length > 0) {
          targetUserId = userResult.rows[0].id;
          console.log('Usuário encontrado pelo email:', targetUserId);
        }
      }

      // Se ainda não tiver user_id, tentar buscar pela subscription existente
      if (!targetUserId && checkoutId) {
        const subResult = await pool.query(
          'SELECT user_id FROM subscriptions WHERE ggcheckout_checkout_id = $1',
          [checkoutId]
        );
        if (subResult.rows.length > 0) {
          targetUserId = subResult.rows[0].user_id;
          console.log('Usuário encontrado pela subscription:', targetUserId);
        }
      }

      if (!targetUserId || !checkoutId) {
        console.error('Dados incompletos no webhook:', { checkoutId, targetUserId, customerEmail });
        return res.status(400).json({ 
          error: 'Dados incompletos',
          received: { checkoutId, userId, customerEmail }
        });
      }

      try {
        // Atualizar usuário para premium
        await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [targetUserId]);
        console.log('Usuário atualizado para premium:', targetUserId);

        // Criar ou atualizar subscription
        await pool.query(
          `INSERT INTO subscriptions (user_id, ggcheckout_checkout_id, status, amount, installments, created_at, updated_at)
           VALUES ($1, $2, 'active', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (ggcheckout_checkout_id) 
           DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP`,
          [
            targetUserId,
            checkoutId,
            data.amount || 2500, // R$ 25,00 em centavos
            data.installments || 1,
          ]
        );
        console.log('Subscription atualizada:', checkoutId);
      } catch (error) {
        console.error('Error updating subscription:', error);
        return res.status(500).json({ error: 'Erro ao atualizar assinatura' });
      }
    }

    res.json({ received: true, event });
  } catch (error: any) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Erro ao processar webhook', details: error.message });
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
