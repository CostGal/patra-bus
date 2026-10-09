// STUB (owner: extras).
export async function shareLink({ url }) { try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'failed'; } }
