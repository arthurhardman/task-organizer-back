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
      // O GGCheckout usa payment.id como identificador do pagamento
      const checkoutId = 
        webhookData?.payment?.id || // ID do pagamento (formato GGCheckout)
        webhookData?.checkout_id || 
        webhookData?.id || 
        webhookData?.checkoutId ||
        webhookData?.transaction_id ||
        webhookData?.webhook?.id || // ID do webhook
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
        customerEmail
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
          // Log detalhado dos produtos para identificar o plano
          console.log('📦 ===== LOGS DE PRODUTOS =====');
          if (webhookData?.products && Array.isArray(webhookData.products)) {
            console.log('📦 Array de produtos:', JSON.stringify(webhookData.products, null, 2));
            webhookData.products.forEach((product: any, index: number) => {
              console.log(`📦 Produto [${index}]:`, {
                id: product?.id,
                title: product?.title,
                name: product?.name,
                type: product?.type,
                price: product?.price,
                amount: product?.amount,
                description: product?.description,
                fullProduct: JSON.stringify(product, null, 2)
              });
            });
          }
          if (webhookData?.product) {
            console.log('📦 Objeto produto único:', {
              id: webhookData.product?.id,
              title: webhookData.product?.title,
              name: webhookData.product?.name,
              type: webhookData.product?.type,
              price: webhookData.product?.price,
              amount: webhookData.product?.amount,
              description: webhookData.product?.description,
              fullProduct: JSON.stringify(webhookData.product, null, 2)
            });
          }
          console.log('📦 ===== FIM DOS LOGS =====');

          // Identificar o plano baseado no ID do produto
          const BASIC_PLAN_CREDITS = 50;
          const BASIC_PLAN_PRICE = 24.90;
          const PREMIUM_PLAN_PRICE = 39.90;
          const BASIC_PRODUCT_ID = 'XMMYz9QVFTWABp3Jl3pQ';
          const PREMIUM_PRODUCT_ID = '3YmbtSMTrFkHujcQN8h8';
          
          let isPremium = false;
          let isBasic = false;
          let planName = 'UNKNOWN';
          let productId = null;
          
          // Verificar produtos no array
          if (webhookData?.products && Array.isArray(webhookData.products) && webhookData.products.length > 0) {
            const product = webhookData.products[0];
            productId = product?.id;
            
            console.log('🔍 Analisando produto do array - ID:', productId);
            
            if (productId === PREMIUM_PRODUCT_ID) {
              isPremium = true;
              planName = 'PREMIUM';
            } else if (productId === BASIC_PRODUCT_ID) {
              isBasic = true;
              planName = 'BASIC';
            }
          }
          
          // Verificar produto único (fallback)
          if (!isPremium && !isBasic && webhookData?.product) {
            productId = webhookData.product?.id;
            
            console.log('🔍 Analisando produto único - ID:', productId);
            
            if (productId === PREMIUM_PRODUCT_ID) {
              isPremium = true;
              planName = 'PREMIUM';
            } else if (productId === BASIC_PRODUCT_ID) {
              isBasic = true;
              planName = 'BASIC';
            }
          }
          
          console.log('🔍 Detecção de plano por ID do produto:', {
            productId,
            isPremium,
            isBasic,
            planName,
            email: customerEmail
          });

          // Atualizar usuário baseado no plano identificado
          if (isPremium) {
            await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [targetUserId]);
            console.log('✅ Usuário atualizado para PREMIUM:', targetUserId, `(email: ${customerEmail})`);
          } else if (isBasic) {
            // Plano básico: adicionar créditos mas não tornar premium
            const { getUserCredits } = await import('../utils/credits');
            const currentCredits = await getUserCredits(targetUserId);
            const newCredits = (currentCredits < 0 ? 0 : currentCredits) + BASIC_PLAN_CREDITS;
            await pool.query('UPDATE users SET credits = $1 WHERE id = $2', [newCredits, targetUserId]);
            console.log(`✅ Plano BÁSICO aplicado: ${BASIC_PLAN_CREDITS} créditos adicionados ao usuário:`, targetUserId, `(email: ${customerEmail})`);
          } else {
            console.warn('⚠️ Plano não identificado pelo ID do produto. Verifique os logs acima.');
            console.warn('⚠️ ID do produto recebido:', productId);
            console.warn('⚠️ IDs esperados:');
            console.warn('   - Básico:', BASIC_PRODUCT_ID);
            console.warn('   - Premium:', PREMIUM_PRODUCT_ID);
            // Não fazer nada se não conseguir identificar
            return res.json({ 
              received: true, 
              event,
              warning: 'Plano não identificado - verificar logs',
              receivedData: { checkoutId, customerEmail, productId }
            });
          }

          // Calcular data de expiração (1 mês a partir de agora para premium, null para básico)
          const expiresAt = isPremium ? (() => {
            const date = new Date();
            date.setMonth(date.getMonth() + 1);
            return date;
          })() : null;

          // Usar valores fixos dos planos, independente do valor que vier do webhook
          let amount: number;
          if (isPremium) {
            amount = PREMIUM_PLAN_PRICE;
          } else if (isBasic) {
            amount = BASIC_PLAN_PRICE;
          } else {
            // Fallback: tentar converter o valor do webhook, mas usar 0 se não conseguir
            const webhookAmount = webhookData?.payment?.amount || 
                                 webhookData?.products?.[0]?.price || 
                                 webhookData?.product?.price || 
                                 0;
            // Converter para número, garantindo que seja válido
            const parsedAmount = typeof webhookAmount === 'string' 
              ? parseFloat(webhookAmount) 
              : typeof webhookAmount === 'number' 
                ? webhookAmount 
                : 0;
            amount = isNaN(parsedAmount) || parsedAmount <= 0 ? 0 : parsedAmount;
          }

          // Garantir que installments seja um número inteiro válido
          const installments = parseInt(String(webhookData?.installments || 1), 10);
          const validInstallments = isNaN(installments) || installments < 1 ? 1 : installments;

          console.log('💰 Valores para subscription:', {
            planName,
            amount,
            amountType: typeof amount,
            installments: validInstallments,
            expiresAt,
            checkoutId
          });

          // Criar ou atualizar subscription
          await pool.query(
            `INSERT INTO subscriptions (user_id, ggcheckout_checkout_id, status, amount, installments, expires_at, created_at, updated_at)
             VALUES ($1, $2, 'active', $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (ggcheckout_checkout_id) 
             DO UPDATE SET status = 'active', amount = $3, expires_at = $5, updated_at = CURRENT_TIMESTAMP`,
            [
              targetUserId,
              checkoutId,
              amount,
              validInstallments,
              expiresAt,
            ]
          );
          console.log('✅ Subscription atualizada:', checkoutId, `(Plano: ${planName}, Valor: R$ ${amount.toFixed(2)})`);
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
      // Calcular data de expiração (1 mês a partir de agora)
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      // Atualizar usuário para premium
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [req.userId]);

      // Atualizar subscription com expires_at
      await pool.query(
        `UPDATE subscriptions 
         SET status = 'active', expires_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE ggcheckout_checkout_id = $1 AND user_id = $2`,
        [checkoutId, req.userId, expiresAt]
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
    const { updateUserPremiumStatus } = await import('../utils/subscription');
    
    // Verificar e atualizar status premium
    const isPremium = await updateUserPremiumStatus(req.userId!);
    
    // Verificar se a coluna expires_at existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'subscriptions' AND column_name = 'expires_at'
    `);
    
    const hasExpiresAt = columnCheck.rows.length > 0;
    
    // Construir query baseado na existência da coluna
    const query = hasExpiresAt
      ? `SELECT s.*
         FROM subscriptions s
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`
      : `SELECT id, user_id, ggcheckout_checkout_id, status, amount, currency, installments, created_at, updated_at
         FROM subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`;
    
    const result = await pool.query(query, [req.userId]);

    const subscription = result.rows[0] || null;
    
    // Verificar se está expirada (apenas se a coluna exists)
    let isExpired = false;
    let daysUntilExpiry = null;
    
    if (hasExpiresAt && subscription?.expires_at) {
      const expiresAt = new Date(subscription.expires_at);
      const now = new Date();
      isExpired = expiresAt <= now;
      
      if (!isExpired) {
        const diffTime = expiresAt.getTime() - now.getTime();
        daysUntilExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      }
    }

    res.json({
      isPremium,
      subscription: subscription ? {
        ...subscription,
        expires_at: subscription.expires_at || null,
        isExpired,
        daysUntilExpiry,
      } : null,
    });
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, retornar resposta básica
    if (error.code === '42703') {
      console.warn('Column expires_at does not exist yet. Run migration script.');
      return res.json({
        isPremium: false,
        subscription: null,
      });
    }
    console.error('Error fetching subscription status:', error);
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

// Get payment history
router.get('/history', authenticate, async (req: AuthRequest, res) => {
  try {
    // Verificar se a coluna expires_at existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'subscriptions' AND column_name = 'expires_at'
    `);
    
    const hasExpiresAt = columnCheck.rows.length > 0;
    
    // Construir query baseado na existência da coluna
    const query = hasExpiresAt
      ? `SELECT 
          id,
          ggcheckout_checkout_id,
          status,
          amount,
          currency,
          installments,
          expires_at,
          created_at,
          updated_at
         FROM subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC`
      : `SELECT 
          id,
          ggcheckout_checkout_id,
          status,
          amount,
          currency,
          installments,
          created_at,
          updated_at
         FROM subscriptions
         WHERE user_id = $1
         ORDER BY created_at DESC`;
    
    const result = await pool.query(query, [req.userId]);

    const history = result.rows.map((row) => ({
      id: row.id,
      checkoutId: row.ggcheckout_checkout_id,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      installments: row.installments,
      expiresAt: hasExpiresAt ? (row.expires_at || null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isExpired: hasExpiresAt && row.expires_at ? new Date(row.expires_at) <= new Date() : false,
    }));

    res.json({ history });
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, retornar histórico sem expires_at
    if (error.code === '42703') {
      console.warn('Column expires_at does not exist yet. Returning history without expiry info.');
      try {
        const result = await pool.query(
          `SELECT 
            id,
            ggcheckout_checkout_id,
            status,
            amount,
            currency,
            installments,
            created_at,
            updated_at
           FROM subscriptions
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [req.userId]
        );
        
        const history = result.rows.map((row) => ({
          id: row.id,
          checkoutId: row.ggcheckout_checkout_id,
          status: row.status,
          amount: row.amount,
          currency: row.currency,
          installments: row.installments,
          expiresAt: null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          isExpired: false,
        }));
        
        return res.json({ history });
      } catch (innerError) {
        console.error('Error fetching payment history (fallback):', innerError);
        return res.status(500).json({ error: 'Erro ao buscar histórico' });
      }
    }
    console.error('Error fetching payment history:', error);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

export { router as paymentRoutes };
