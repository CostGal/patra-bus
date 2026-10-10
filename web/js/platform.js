// Platform detection for the install tutorial (owner: guide). Pure: no DOM or i18n at import, node-testable.
// detectPlatform() takes the raw signals; currentPlatform() reads the real globals and never throws.
// User-agent sniffing is a best effort (iOS and Android browsers hide behind each other's tokens), so every
// uncertain case falls to 'other' and the tutorial then shows the generic steps.

const IOS_UA = /iPhone|iPod|iPad/;
// Browsers embedded in other apps (no install UI at all). Android WebViews carry "; wv)".
const INAPP_UA = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|musical_ly|BytedanceWebview|TikTok|LinkedInApp|Snapchat|Twitter|Pinterest|MicroMessenger|\bLine\/|\bGSA\/|; wv\)|\bWebView\b/i;
// Other Chromium/WebKit forks we do not give their own steps.
const OTHER_UA = /OPR\/|OPT\/|OPiOS|Opera|Vivaldi|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|DuckDuckGo|Silk\//;

export function detectPlatform({ ua, platform, maxTouchPoints, standalone, displayModeStandalone, hasInstallPrompt } = {}) {
  ua = String(ua || '');
  const iosUa = IOS_UA.test(ua);
  // iPadOS 13+ in "desktop website" mode sends a Mac UA; only a touch screen tells it from a real Mac.
  const ipadDesktop = !iosUa && platform === 'MacIntel' && Number(maxTouchPoints) > 1;
  const os = iosUa || ipadDesktop ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  const mode = standalone === true || displayModeStandalone === true ? 'app' : 'browser';

  let browser;
  if (INAPP_UA.test(ua)) browser = 'inapp';
  // A WKWebView app has no "Safari/" token (but so does an installed iOS web app, which is not a webview).
  else if (iosUa && mode === 'browser' && !/Safari\//.test(ua)) browser = 'inapp';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (OTHER_UA.test(ua)) browser = 'other';
  else if (/EdgA|EdgiOS|Edg\//.test(ua)) browser = 'edge';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) || iosUa || ipadDesktop) browser = 'safari';
  else browser = 'other';

  // The deferred install prompt only exists on Chromium (never iOS) and only while not yet installed.
  const canPrompt = !!hasInstallPrompt && os !== 'ios' && mode === 'browser' && browser !== 'inapp';
  return { os, mode, browser, canPrompt };
}

// Reads the real globals. Safe with none of them present (node, workers, odd webviews).
export function currentPlatform({ hasInstallPrompt = false } = {}) {
  const nav = globalThis.navigator || {};
  let displayModeStandalone = false;
  try {
    displayModeStandalone = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
      .some((m) => globalThis.matchMedia?.(`(display-mode: ${m})`)?.matches === true);
  } catch { /* matchMedia missing or throwing */ }
  let standalone;
  try { standalone = nav.standalone; } catch { /* ignore */ }
  return detectPlatform({
    ua: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints,
    standalone, displayModeStandalone, hasInstallPrompt,
  });
}

// Pure core of install-guide.js installHint(): a suggestion only makes sense on a phone/tablet in a browser tab.
export function installHintFor(p) {
  if (!p || p.mode !== 'browser' || (p.os !== 'ios' && p.os !== 'android')) return null;
  return { os: p.os, browser: p.browser };
}
