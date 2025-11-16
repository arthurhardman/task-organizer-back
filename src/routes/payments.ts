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
    // Log completo do body recebido para debug
    console.log('Webhook recebido - Body completo:', JSON.stringify(req.body, null, 2));
    console.log('Webhook recebido - Headers:', req.headers);

    const { event, data, ...rest } = req.body;

    // A estrutura pode variar - tentar diferentes formatos
    const webhookData = data || rest || req.body;
    
    console.log('Event:', event);
    console.log('Data extraída:', webhookData);

    // Verificar assinatura do webhook (se GGCheckout fornecer)
    const webhookSecret = process.env.GGCHECKOUT_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-ggcheckout-signature'];
      // TODO: Implementar verificação de assinatura se GGCheckout fornecer
      // if (signature !== expectedSignature) {
      //   return res.status(401).json({ error: 'Assinatura inválida' });
      // }
    }

    // Processar eventos de pagamento
    const paymentEvents = [
      'payment.completed',
      'payment.approved',
      'checkout.completed',
      'pix.paid', // PIX pago
      'pix.generated', // PIX gerado (aguardando pagamento)
    ];

    if (paymentEvents.includes(event)) {
      // Extrair informações de diferentes formatos possíveis
      const checkoutId = 
        webhookData?.checkout_id || 
        webhookData?.id || 
        webhookData?.checkoutId ||
        webhookData?.transaction_id ||
        rest?.checkout_id ||
        rest?.id;

      const userId = 
        webhookData?.metadata?.user_id ||
        webhookData?.user_id ||
        webhookData?.customer_id ||
        rest?.user_id;

      const customerEmail = 
        webhookData?.customer?.email ||
        webhookData?.email ||
        webhookData?.customer_email ||
        webhookData?.payer?.email ||
        rest?.email;

      console.log('Processando pagamento:', { 
        event, 
        checkoutId, 
        userId, 
        customerEmail,
        webhookData 
      });

      // Para pix.generated, apenas logar (aguardando pagamento)
      if (event === 'pix.generated') {
        console.log('PIX gerado, aguardando pagamento:', checkoutId);
        return res.json({ received: true, event, message: 'PIX gerado, aguardando pagamento' });
      }

      // Para pix.paid e outros eventos de pagamento aprovado, processar
      if (event === 'pix.paid' || event === 'payment.completed' || event === 'payment.approved' || event === 'checkout.completed') {
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

        if (!targetUserId) {
          console.error('Não foi possível identificar o usuário:', { 
            checkoutId, 
            customerEmail,
            webhookData 
          });
          // Retornar sucesso mas logar o erro para investigação
          return res.json({ 
            received: true, 
            event,
            warning: 'Usuário não identificado - verificar logs',
            receivedData: { checkoutId, customerEmail }
          });
        }

        if (!checkoutId) {
          console.error('Checkout ID não encontrado no webhook');
          return res.status(400).json({ 
            error: 'Checkout ID não encontrado',
            received: webhookData
          });
        }

        try {
          // Atualizar usuário para premium
          await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [targetUserId]);
          console.log('✅ Usuário atualizado para premium:', targetUserId);

          // Criar ou atualizar subscription
          await pool.query(
            `INSERT INTO subscriptions (user_id, ggcheckout_checkout_id, status, amount, installments, created_at, updated_at)
             VALUES ($1, $2, 'active', $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (ggcheckout_checkout_id) 
             DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP`,
            [
              targetUserId,
              checkoutId,
              webhookData?.amount || webhookData?.value || 2500, // R$ 25,00 em centavos
              webhookData?.installments || 1,
            ]
          );
          console.log('✅ Subscription atualizada:', checkoutId);
        } catch (error) {
          console.error('❌ Error updating subscription:', error);
          return res.status(500).json({ error: 'Erro ao atualizar assinatura' });
        }
      }
    } else {
      console.log('Evento não processado:', event);
    }

    res.json({ received: true, event });
  } catch (error: any) {
    console.error('❌ Webhook error:', error);
    console.error('Error stack:', error.stack);
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
