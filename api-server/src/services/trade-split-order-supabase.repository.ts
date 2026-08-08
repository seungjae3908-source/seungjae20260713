import { getUserSupabase } from '../lib/supabase';
import { createSplitOrderRepository, type SplitOrderDatabasePort, type SplitOrderRepository } from './trade-split-order.repository';

export function createSupabaseSplitOrderRepository(
  accessToken: string,
  authenticatedUserId: string,
): SplitOrderRepository {
  if (!accessToken || !authenticatedUserId) throw new Error('LOGIN_REQUIRED');
  let repository: SplitOrderRepository | null = null;
  const current = () => {
    if (repository) return repository;
    const client = getUserSupabase(accessToken);
    const database: SplitOrderDatabasePort = {
      async rpc(name, args) {
        const { data, error } = await client.rpc(name, args);
        return { data, error };
      },
      async listOrderPayloads(userId, planId, approvedPlanVersion) {
        let query = client.from('trade_orders').select('payload')
          .eq('user_id', userId)
          .eq('plan_id', planId)
          .order('leg_sequence_no', { ascending: true });
        if (approvedPlanVersion !== undefined) {
          query = query.eq('approved_plan_version', approvedPlanVersion);
        }
        const { data, error } = await query;
        return { data, error };
      },
    };
    repository = createSplitOrderRepository(database, authenticatedUserId);
    return repository;
  };
  return {
    listOrdersByPlan: (...args) => current().listOrdersByPlan(...args),
    createSplitOrdersAtomic: (input) => current().createSplitOrdersAtomic(input),
    activateNextChildAtomic: (order, event) => current().activateNextChildAtomic(order, event),
    cancelPlannedChildrenAtomic: (input) => current().cancelPlannedChildrenAtomic(input),
  };
}
