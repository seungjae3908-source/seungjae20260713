import { AccountReadonlyService } from './account-readonly.service';
import { createVaultBackedAccountReaders } from './account-readonly.runtime';
import { accountReadFlags } from './account-readonly.route';
import { accountReadonlyCredentialConfigured } from './account-readonly.repository';

/**
 * Process-wide READ_ONLY account service.
 * Sharing one instance preserves provider token caches and same-user last-good
 * state across the account screen and portfolio intelligence without granting
 * any additional authority.
 */
export const accountReadonlyRuntimeService = new AccountReadonlyService(
  createVaultBackedAccountReaders(),
  accountReadFlags(),
  () => new Date(),
  accountReadonlyCredentialConfigured,
);
