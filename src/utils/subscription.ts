import { pool } from '../db';

/**
 * Verifica se a assinatura do usuário está ativa (não expirada)
 */
export async function checkSubscriptionStatus(userId: number): Promise<boolean> {
  try {
    // Verificar se a coluna expires_at existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'subscriptions' AND column_name = 'expires_at'
    `);
    
    const hasExpiresAt = columnCheck.rows.length > 0;
    
    // Se não tem a coluna, usar query sem expires_at
    const query = hasExpiresAt
      ? `SELECT expires_at, status 
         FROM subscriptions 
         WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`
      : `SELECT status 
         FROM subscriptions 
         WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`;
    
    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return false;
    }

    const subscription = result.rows[0];
    
    // Se não tem expires_at (coluna não existe ou é null), considerar como ativo
    if (!hasExpiresAt || !subscription.expires_at) {
      return true;
    }

    // Verificar se ainda não expirou
    const expiresAt = new Date(subscription.expires_at);
    const now = new Date();
    
    return expiresAt > now;
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, considerar como ativo (compatibilidade)
    if (error.code === '42703') {
      console.warn('Column expires_at does not exist yet. Run migration script.');
      return true;
    }
    console.error('Error checking subscription status:', error);
    return false;
  }
}

/**
 * Atualiza o status premium do usuário baseado na assinatura
 * Nota: Usuários business sempre são premium
 */
export async function updateUserPremiumStatus(userId: number): Promise<boolean> {
  try {
    // Verificar se usuário é business primeiro
    const userResult = await pool.query(
      'SELECT is_business FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return false;
    }

    const isBusiness = userResult.rows[0].is_business || false;

    // Se for business, sempre é premium
    if (isBusiness) {
      await pool.query(
        'UPDATE users SET is_premium = TRUE WHERE id = $1',
        [userId]
      );
      return true;
    }

    // Se não for business, verificar assinatura
    const isActive = await checkSubscriptionStatus(userId);
    
    await pool.query(
      'UPDATE users SET is_premium = $1 WHERE id = $2',
      [isActive, userId]
    );

    return isActive;
  } catch (error) {
    console.error('Error updating user premium status:', error);
    return false;
  }
}

