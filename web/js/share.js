// Share a link (owner: extras): Web Share API → clipboard → 'failed'.
// Returns 'shared' | 'copied' | 'failed', plus 'cancelled' when the user dismissed the native share sheet
// (callers should stay silent on it).

const absolute = (u) => { try { return new URL(u ?? '', globalThis.location?.href).href; } catch { return String(u ?? ''); } };

async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back to the legacy path */ }
  try { // insecure contexts / older webviews
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.setAttribute('aria-hidden', 'true');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

export async function shareLink({ title, text, url } = {}) {
  url = absolute(url);
  const data = { title, text, url };
  try {
    if (typeof navigator !== 'undefined' && navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      await navigator.share(data);
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled'; // user closed the sheet: not an error, no clipboard surprise
    // any other failure → try the clipboard
  }
  return (await copy(url)) ? 'copied' : 'failed';
}
