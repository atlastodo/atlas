import type { Persistence } from "@atlastodo/client-core";

/** The databases open per user, so deleting one can close them first. */
const openByUser = new Map<string, Set<Persistence>>();

/** Remember `p` as open on `userId`'s database until its `close()`. */
export function trackOpen(userId: string, p: Persistence): Persistence {
  const open = openByUser.get(userId) ?? new Set();
  openByUser.set(userId, open);
  open.add(p);
  const close = p.close?.bind(p);
  p.close = async () => {
    open.delete(p);
    await close?.();
  };
  return p;
}

/** Close every connection still open on `userId`'s database. */
export async function closeAll(userId: string): Promise<void> {
  for (const p of [...(openByUser.get(userId) ?? [])]) await p.close?.();
}
