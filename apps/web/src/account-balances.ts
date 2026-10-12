import { fetchAccountList, syncAccount } from './api.ts';

/** Refresh the complete list, regardless of the table's search or group filter.
 * Finish every batch even if some accounts fail; never label stale balances fresh. */
export async function refreshAccountListBalances() {
  const accounts = (await fetchAccountList()).filter(account => account.status !== 'disconnected');
  const failed: string[] = [];
  let refreshed = 0;
  for (let i = 0; i < accounts.length; i += 8) {
    const batch = accounts.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map(account => syncAccount(account.id)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') refreshed++;
      else failed.push(batch[index]!.name);
    });
  }
  return { refreshed, failed };
}
