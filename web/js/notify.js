// STUB (owner: extras).
export async function ensurePermission() { return false; }
export function scheduleReminder({ at }) { const t = setTimeout(() => {}, Math.max(0, at - Date.now())); return { cancel: () => clearTimeout(t) }; }
export const listReminders = () => [];
