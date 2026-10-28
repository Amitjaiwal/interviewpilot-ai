/** Session ids: a readable prefix plus time and randomness, matching the main-process id rules. */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
