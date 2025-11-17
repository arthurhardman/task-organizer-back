import { pool } from '../db';

/**
 * Verifica se a assinatura do usuário está ativa (não expirada)
 */
export async function checkSubscriptionStatus(userId: number): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT expires_at, status 
       FROM subscriptions 
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const subscription = result.rows[0];
    
    // Se não tem expires_at, considerar como ativo (compatibilidade com dados antigos)
    if (!subscription.expires_at) {
      return true;
    }

    // Verificar se ainda não expirou
    const expiresAt = new Date(subscription.expires_at);
    const now = new Date();
    
    return expiresAt > now;
  } catch (error) {
    console.error('Error checking subscription status:', error);
    return false;
  }
}

/**
 * Atualiza o status premium do usuário baseado na assinatura
 */
export async function updateUserPremiumStatus(userId: number): Promise<boolean> {
  try {
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

