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

// Preparar dados da empresa antes de contratar plano business
router.post('/business/prepare', authenticate, async (req: AuthRequest, res) => {
  try {
    const { razao_social, cnpj } = req.body;

    if (!razao_social || !cnpj) {
      return res.status(400).json({ error: 'Razão Social e CNPJ são obrigatórios' });
    }

    // Validar formato básico do CNPJ (14 dígitos)
    const cnpjClean = cnpj.replace(/[^\d]/g, '');
    if (cnpjClean.length !== 14) {
      return res.status(400).json({ error: 'CNPJ inválido. Deve conter 14 dígitos.' });
    }

    // Verificar se já existe business com este CNPJ
    const existingBusiness = await pool.query(
      'SELECT id FROM businesses WHERE cnpj = $1',
      [cnpjClean]
    );

    if (existingBusiness.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma empresa cadastrada com este CNPJ' });
    }

    // Verificar se usuário já tem business
    const userResult = await pool.query(
      'SELECT business_id FROM users WHERE id = $1',
      [req.userId]
    );

    let businessId: number | null = null;

    if (userResult.rows.length > 0 && userResult.rows[0].business_id) {
      // Usuário já tem business - atualizar dados
      businessId = userResult.rows[0].business_id;
      await pool.query(
        'UPDATE businesses SET razao_social = $1, cnpj = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [razao_social, cnpjClean, businessId]
      );
    } else {
      // Criar novo business com os dados fornecidos
      const domain = req.body.email?.split('@')[1]?.toLowerCase() || `empresa-${Date.now()}.com`;
      const businessResult = await pool.query(
        'INSERT INTO businesses (name, razao_social, cnpj, domain, max_users) VALUES ($1, $2, $3, $4, 20) RETURNING id',
        [razao_social, razao_social, cnpjClean, domain]
      );
      businessId = businessResult.rows[0].id;

      // Associar usuário ao business
      await pool.query(
        'UPDATE users SET business_id = $1 WHERE id = $2',
        [businessId, req.userId]
      );
    }

    res.json({
      message: 'Dados da empresa salvos com sucesso',
      businessId,
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'CNPJ já cadastrado' });
    }
    console.error('Error preparing business data:', error);
    res.status(500).json({ error: 'Erro ao preparar dados da empresa' });
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
          const BUSINESS_PLAN_PRICE = 99.90; // Preço do plano business
          const BASIC_PRODUCT_ID = 'XMMYz9QVFTWABp3Jl3pQ';
          const PREMIUM_PRODUCT_ID = '3YmbtSMTrFkHujcQN8h8';
          const BUSINESS_PRODUCT_ID = 'Ndm28xW40nGEP5oRSNE4';
          
          let isPremium = false;
          let isBasic = false;
          let isBusiness = false;
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
            } else if (productId === BUSINESS_PRODUCT_ID) {
              isBusiness = true;
              planName = 'BUSINESS';
            }
          }
          
          // Verificar produto único (fallback)
          if (!isPremium && !isBasic && !isBusiness && webhookData?.product) {
            productId = webhookData.product?.id;
            
            console.log('🔍 Analisando produto único - ID:', productId);
            
            if (productId === PREMIUM_PRODUCT_ID) {
              isPremium = true;
              planName = 'PREMIUM';
            } else if (productId === BASIC_PRODUCT_ID) {
              isBasic = true;
              planName = 'BASIC';
            } else if (productId === BUSINESS_PRODUCT_ID) {
              isBusiness = true;
              planName = 'BUSINESS';
            }
          }
          
          console.log('🔍 Detecção de plano por ID do produto:', {
            productId,
            isPremium,
            isBasic,
            isBusiness,
            planName,
            email: customerEmail
          });

          // Atualizar usuário baseado no plano identificado
          if (isBusiness) {
            // Plano Business: ativar is_business, is_premium e tornar admin
            await pool.query('UPDATE users SET is_business = TRUE, is_premium = TRUE, is_admin = TRUE WHERE id = $1', [targetUserId]);
            
            // Obter business_id do usuário para atualizar o business
            const userBusinessResult = await pool.query(
              'SELECT business_id FROM users WHERE id = $1',
              [targetUserId]
            );
            
            if (userBusinessResult.rows.length > 0 && userBusinessResult.rows[0].business_id) {
              const businessId = userBusinessResult.rows[0].business_id;
              // Garantir que o business tenha max_users = 20 e extra_users_count = 0
              await pool.query(
                'UPDATE businesses SET max_users = 20, extra_users_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [businessId]
              );
              
              // Verificar se business tem razao_social e cnpj (obrigatórios)
              const businessCheck = await pool.query(
                'SELECT razao_social, cnpj FROM businesses WHERE id = $1',
                [businessId]
              );
              
              if (businessCheck.rows.length > 0 && (!businessCheck.rows[0].razao_social || !businessCheck.rows[0].cnpj)) {
                console.warn('⚠️ Business ativado mas sem Razão Social ou CNPJ. Dados devem ser preenchidos antes do pagamento.');
              }
            } else {
              console.warn('⚠️ Usuário contratou plano Business mas não possui business associado. Business deve ser criado antes do pagamento.');
            }
            
            console.log('✅ Usuário atualizado para BUSINESS (admin):', targetUserId, `(email: ${customerEmail})`);
          } else if (isPremium) {
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
            console.warn('   - Business:', BUSINESS_PRODUCT_ID);
            // Não fazer nada se não conseguir identificar
            return res.json({ 
              received: true, 
              event,
              warning: 'Plano não identificado - verificar logs',
              receivedData: { checkoutId, customerEmail, productId }
            });
          }

          // Calcular data de expiração (1 mês a partir de agora para premium/business, null para básico)
          const expiresAt = (isPremium || isBusiness) ? (() => {
            const date = new Date();
            date.setMonth(date.getMonth() + 1);
            return date;
          })() : null;

          // Usar valores fixos dos planos, independente do valor que vier do webhook
          let amount: number;
          if (isBusiness) {
            amount = BUSINESS_PLAN_PRICE;
          } else if (isPremium) {
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

// Calcular valor da renovação do business (usuários extras + renovação)
router.get('/business/renewal-cost', authenticate, async (req: AuthRequest, res) => {
  try {
    // Verificar se usuário é admin de business
    const userResult = await pool.query(
      'SELECT business_id, is_admin, is_business FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];

    if (!user.is_business || !user.is_admin || !user.business_id) {
      return res.status(403).json({ error: 'Apenas administradores de empresas com plano Business podem acessar esta funcionalidade' });
    }

    const businessId = user.business_id;

    // Buscar subscription ativa do business
    const subscriptionResult = await pool.query(
      `SELECT s.id, s.expires_at, s.created_at, s.amount
       FROM subscriptions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE u.business_id = $1 AND u.is_business = TRUE AND s.status = 'active'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [businessId]
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Nenhuma assinatura ativa encontrada' });
    }

    const subscription = subscriptionResult.rows[0];
    const expiresAt = subscription.expires_at ? new Date(subscription.expires_at) : null;

    if (!expiresAt) {
      return res.status(400).json({ error: 'Assinatura sem data de expiração' });
    }

    // Buscar usuários extras não cobrados do período atual
    const extraUsersResult = await pool.query(
      `SELECT COUNT(*) as count, SUM(cost) as total_cost
       FROM extra_users_history
       WHERE business_id = $1 
         AND subscription_period_start >= $2
         AND subscription_period_end <= $3
         AND charged = FALSE`,
      [businessId, subscription.created_at, expiresAt]
    );

    const extraUsersCount = parseInt(extraUsersResult.rows[0].count || '0');
    const extraUsersCost = parseFloat(extraUsersResult.rows[0].total_cost || '0');

    // Valor da renovação do business (R$ 99,90)
    const BUSINESS_PLAN_PRICE = 99.90;
    const renewalCost = BUSINESS_PLAN_PRICE;
    const totalCost = renewalCost + extraUsersCost;

    res.json({
      businessId,
      subscriptionId: subscription.id,
      expiresAt,
      renewalCost,
      extraUsersCount,
      extraUsersCost,
      totalCost,
      breakdown: {
        businessRenewal: renewalCost,
        extraUsers: extraUsersCost,
        total: totalCost,
      },
    });
  } catch (error) {
    console.error('Error calculating renewal cost:', error);
    res.status(500).json({ error: 'Erro ao calcular custo de renovação' });
  }
});

// Processar renovação do business (marcar usuários extras como cobrados e criar nova subscription)
router.post('/business/renew', authenticate, async (req: AuthRequest, res) => {
  try {
    // Verificar se usuário é admin de business
    const userResult = await pool.query(
      'SELECT business_id, is_admin, is_business FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user = userResult.rows[0];

    if (!user.is_business || !user.is_admin || !user.business_id) {
      return res.status(403).json({ error: 'Apenas administradores de empresas com plano Business podem renovar' });
    }

    const businessId = user.business_id;

    // Buscar subscription ativa do business
    const subscriptionResult = await pool.query(
      `SELECT s.id, s.expires_at, s.created_at, s.ggcheckout_checkout_id
       FROM subscriptions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE u.business_id = $1 AND u.is_business = TRUE AND s.status = 'active'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [businessId]
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Nenhuma assinatura ativa encontrada' });
    }

    const subscription = subscriptionResult.rows[0];
    const expiresAt = subscription.expires_at ? new Date(subscription.expires_at) : null;

    if (!expiresAt) {
      return res.status(400).json({ error: 'Assinatura sem data de expiração' });
    }

    // Marcar usuários extras do período como cobrados
    await pool.query(
      `UPDATE extra_users_history
       SET charged = TRUE
       WHERE business_id = $1 
         AND subscription_period_start >= $2
         AND subscription_period_end <= $3
         AND charged = FALSE`,
      [businessId, subscription.created_at, expiresAt]
    );

    // Calcular nova data de expiração (1 mês a partir de agora)
    const newExpiresAt = new Date();
    newExpiresAt.setMonth(newExpiresAt.getMonth() + 1);

    // Criar nova subscription (será atualizada pelo webhook quando o pagamento for processado)
    // Por enquanto, apenas retornamos sucesso
    res.json({
      message: 'Renovação processada. Aguarde confirmação do pagamento.',
      businessId,
      newExpiresAt,
    });
  } catch (error) {
    console.error('Error processing renewal:', error);
    res.status(500).json({ error: 'Erro ao processar renovação' });
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
