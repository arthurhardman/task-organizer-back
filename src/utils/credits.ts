import { pool } from '../db';

const INITIAL_CREDITS = 25;
const CREDITS_PER_ACTION = 5;

/**
 * Inicializa créditos para um usuário (se não tiver)
 */
export async function initializeCredits(userId: number): Promise<number> {
  try {
    // Verificar se a coluna credits existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'credits'
    `);
    
    const hasCreditsColumn = columnCheck.rows.length > 0;
    
    if (!hasCreditsColumn) {
      console.warn('Column credits does not exist yet. Run migration script.');
      return INITIAL_CREDITS; // Retornar valor padrão temporariamente
    }
    
    const result = await pool.query(
      'SELECT credits FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return 0;
    }

    // Se credits é null, inicializar com valor padrão
    if (result.rows[0].credits === null) {
      await pool.query(
        'UPDATE users SET credits = $1 WHERE id = $2',
        [INITIAL_CREDITS, userId]
      );
      return INITIAL_CREDITS;
    }

    return result.rows[0].credits;
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, retornar valor padrão
    if (error.code === '42703') {
      console.warn('Column credits does not exist yet. Run migration script.');
      return INITIAL_CREDITS;
    }
    console.error('Error initializing credits:', error);
    return INITIAL_CREDITS; // Retornar valor padrão em caso de erro
  }
}

/**
 * Verifica se o usuário tem créditos suficientes
 */
export async function hasEnoughCredits(userId: number, required: number = CREDITS_PER_ACTION): Promise<boolean> {
  try {
    // Verificar se a coluna credits existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'credits'
    `);
    
    const hasCreditsColumn = columnCheck.rows.length > 0;
    
    if (!hasCreditsColumn) {
      // Se a coluna não existe, permitir ação (compatibilidade temporária)
      console.warn('Column credits does not exist yet. Allowing action.');
      return true;
    }
    
    const result = await pool.query(
      'SELECT credits, is_premium FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    const user = result.rows[0];

    // Usuários premium não precisam de créditos
    if (user.is_premium) {
      return true;
    }

    // Inicializar créditos se for null
    let credits = user.credits;
    if (credits === null) {
      credits = await initializeCredits(userId);
    }

    return credits >= required;
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, permitir ação
    if (error.code === '42703') {
      console.warn('Column credits does not exist yet. Allowing action.');
      return true;
    }
    console.error('Error checking credits:', error);
    return false;
  }
}

/**
 * Consome créditos do usuário (se não for premium)
 */
export async function consumeCredits(userId: number, amount: number = CREDITS_PER_ACTION): Promise<{ success: boolean; remaining: number }> {
  try {
    // Verificar se a coluna credits existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'credits'
    `);
    
    const hasCreditsColumn = columnCheck.rows.length > 0;
    
    if (!hasCreditsColumn) {
      // Se a coluna não existe, permitir ação (compatibilidade temporária)
      console.warn('Column credits does not exist yet. Allowing action.');
      return { success: true, remaining: INITIAL_CREDITS };
    }
    
    const result = await pool.query(
      'SELECT credits, is_premium FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return { success: false, remaining: 0 };
    }

    const user = result.rows[0];

    // Usuários premium não consomem créditos
    if (user.is_premium) {
      const credits = user.credits || INITIAL_CREDITS;
      return { success: true, remaining: credits };
    }

    // Inicializar créditos se for null
    let credits = user.credits;
    if (credits === null) {
      credits = await initializeCredits(userId);
    }

    // Verificar se tem créditos suficientes
    if (credits < amount) {
      return { success: false, remaining: credits };
    }

    // Consumir créditos
    const newCredits = credits - amount;
    await pool.query(
      'UPDATE users SET credits = $1 WHERE id = $2',
      [newCredits, userId]
    );

    return { success: true, remaining: newCredits };
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, permitir ação
    if (error.code === '42703') {
      console.warn('Column credits does not exist yet. Allowing action.');
      return { success: true, remaining: INITIAL_CREDITS };
    }
    console.error('Error consuming credits:', error);
    return { success: false, remaining: 0 };
  }
}

/**
 * Obtém créditos do usuário
 */
export async function getUserCredits(userId: number): Promise<number> {
  try {
    // Verificar se a coluna credits existe
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'credits'
    `);
    
    const hasCreditsColumn = columnCheck.rows.length > 0;
    
    if (!hasCreditsColumn) {
      // Se a coluna não existe, retornar valor padrão
      console.warn('Column credits does not exist yet. Returning default value.');
      return INITIAL_CREDITS;
    }
    
    const result = await pool.query(
      'SELECT credits, is_premium FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return 0;
    }

    const user = result.rows[0];

    // Usuários premium não têm limite de créditos
    if (user.is_premium) {
      return -1; // -1 significa ilimitado
    }

    // Inicializar créditos se for null
    if (user.credits === null) {
      return await initializeCredits(userId);
    }

    return user.credits;
  } catch (error: any) {
    // Se o erro for de coluna não encontrada, retornar valor padrão
    if (error.code === '42703') {
      console.warn('Column credits does not exist yet. Returning default value.');
      return INITIAL_CREDITS;
    }
    console.error('Error getting user credits:', error);
    return INITIAL_CREDITS; // Retornar valor padrão em caso de erro
  }
}

