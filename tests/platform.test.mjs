import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, currentPlatform, installHintFor } from '../web/js/platform.js';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneStandalone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  iosFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  iosEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.2592.87 Mobile/15E148 Safari/604.1',
  iosInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 340.0.0.30.109 (iPhone14,5; iOS 17_5; el_GR; el; scale=3.00; 1170x2532; 600757776)',
  iosFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.55.109;FBBV/580000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/el_GR;FBOP/5;FBRV/0]',
  iosMessenger: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/460.0.0.35.109;FBBV/580000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5]',
  iosTikTok: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.0.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/el Region/GR',
  iosGoogleApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/330.0.656174543 Mobile/15E148 Safari/604.1',
  iosLinkedIn: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp/9.30.1005',
  iosWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  androidEdge: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.2592.80',
  androidOpera: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 OPR/80.0.4170.63',
  androidWebview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240605.024; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240605.024; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.43.109;]',
  androidInstagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36 Instagram 340.0.0.31.93 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 600757776)',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  desktopFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

const r = (os, mode, browser, canPrompt) => ({ os, mode, browser, canPrompt });

const CASES = [
  ['1 iPhone Safari in a tab', { ua: UA.iphoneSafari }, r('ios', 'browser', 'safari', false)],
  ['2 iPhone installed web app (standalone: true)', { ua: UA.iphoneStandalone, standalone: true }, r('ios', 'app', 'safari', false)],
  ['3 iPad classic UA', { ua: UA.ipadSafari }, r('ios', 'browser', 'safari', false)],
  ['4 iPadOS desktop mode', { ua: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }, r('ios', 'browser', 'safari', false)],
  ['5 real Mac Safari', { ua: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, r('other', 'browser', 'safari', false)],
  ['6 iOS Chrome', { ua: UA.iosChrome }, r('ios', 'browser', 'chrome', false)],
  ['7 iOS Firefox', { ua: UA.iosFirefox }, r('ios', 'browser', 'firefox', false)],
  ['8 iOS Edge', { ua: UA.iosEdge }, r('ios', 'browser', 'edge', false)],
  ['9 iOS Instagram', { ua: UA.iosInstagram }, r('ios', 'browser', 'inapp', false)],
  ['10 iOS Facebook', { ua: UA.iosFacebook }, r('ios', 'browser', 'inapp', false)],
  ['11 iOS Messenger', { ua: UA.iosMessenger }, r('ios', 'browser', 'inapp', false)],
  ['12 iOS TikTok', { ua: UA.iosTikTok }, r('ios', 'browser', 'inapp', false)],
  ['13 iOS Google app', { ua: UA.iosGoogleApp }, r('ios', 'browser', 'inapp', false)],
  ['14 iOS LinkedIn', { ua: UA.iosLinkedIn }, r('ios', 'browser', 'inapp', false)],
  ['15 generic iOS WKWebView (no Safari token, not standalone)', { ua: UA.iosWebview }, r('ios', 'browser', 'inapp', false)],
  ['16 iOS never gets canPrompt even if told it has a prompt', { ua: UA.iphoneSafari, hasInstallPrompt: true }, r('ios', 'browser', 'safari', false)],
  ['17 Android Chrome', { ua: UA.androidChrome }, r('android', 'browser', 'chrome', false)],
  ['18 Android Chrome with captured install prompt', { ua: UA.androidChrome, hasInstallPrompt: true }, r('android', 'browser', 'chrome', true)],
  ['19 Android Chrome installed via display-mode', { ua: UA.androidChrome, displayModeStandalone: true, hasInstallPrompt: true }, r('android', 'app', 'chrome', false)],
  ['20 Android Samsung', { ua: UA.androidSamsung }, r('android', 'browser', 'samsung', false)],
  ['21 Android Samsung with prompt', { ua: UA.androidSamsung, hasInstallPrompt: true }, r('android', 'browser', 'samsung', true)],
  ['22 Android Firefox', { ua: UA.androidFirefox }, r('android', 'browser', 'firefox', false)],
  ['23 Android Edge', { ua: UA.androidEdge }, r('android', 'browser', 'edge', false)],
  ['24 Android Opera', { ua: UA.androidOpera }, r('android', 'browser', 'other', false)],
  ['25 Android WebView', { ua: UA.androidWebview }, r('android', 'browser', 'inapp', false)],
  ['26 Android Facebook', { ua: UA.androidFacebook }, r('android', 'browser', 'inapp', false)],
  ['27 Android Instagram', { ua: UA.androidInstagram }, r('android', 'browser', 'inapp', false)],
  ['28 Android in-app never canPrompt', { ua: UA.androidWebview, hasInstallPrompt: true }, r('android', 'browser', 'inapp', false)],
  ['29 desktop Chrome', { ua: UA.desktopChrome }, r('other', 'browser', 'chrome', false)],
  ['30 desktop Chrome with prompt', { ua: UA.desktopChrome, hasInstallPrompt: true }, r('other', 'browser', 'chrome', true)],
  ['31 desktop Chrome installed', { ua: UA.desktopChrome, displayModeStandalone: true }, r('other', 'app', 'chrome', false)],
  ['32 desktop Edge', { ua: UA.desktopEdge }, r('other', 'browser', 'edge', false)],
  ['33 desktop Firefox', { ua: UA.desktopFirefox }, r('other', 'browser', 'firefox', false)],
  ['34 empty input', {}, r('other', 'browser', 'other', false)],
];

for (const [name, input, expected] of CASES) {
  test(name, () => assert.deepEqual(detectPlatform(input), expected));
}

test('35 no argument at all', () => {
  assert.deepEqual(detectPlatform(), { os: 'other', mode: 'browser', browser: 'other', canPrompt: false });
});

test('currentPlatform is safe with no globals at all', () => {
  assert.deepEqual(currentPlatform(), r('other', 'browser', 'other', false));
});

test('currentPlatform reads navigator and any app display-mode', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  try {
    set({ userAgent: UA.iphoneSafari, platform: 'iPhone', maxTouchPoints: 5, standalone: true });
    assert.deepEqual(currentPlatform(), r('ios', 'app', 'safari', false));
    set({ userAgent: UA.androidChrome, platform: 'Linux armv81', maxTouchPoints: 5 });
    assert.deepEqual(currentPlatform({ hasInstallPrompt: true }), r('android', 'browser', 'chrome', true));
    for (const mode of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
      globalThis.matchMedia = (q) => ({ matches: q === `(display-mode: ${mode})` });
      assert.equal(currentPlatform().mode, 'app', mode);
    }
    globalThis.matchMedia = () => { throw new Error('boom'); };
    assert.equal(currentPlatform().mode, 'browser'); // a throwing matchMedia never breaks detection
  } finally {
    delete globalThis.matchMedia;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});

test('installHintFor: only phones/tablets in a browser tab', () => {
  assert.deepEqual(installHintFor(r('ios', 'browser', 'safari', false)), { os: 'ios', browser: 'safari' });
  assert.deepEqual(installHintFor(r('android', 'browser', 'samsung', true)), { os: 'android', browser: 'samsung' });
  assert.deepEqual(installHintFor(r('android', 'browser', 'inapp', false)), { os: 'android', browser: 'inapp' });
  assert.equal(installHintFor(r('ios', 'app', 'safari', false)), null); // already installed
  assert.equal(installHintFor(r('android', 'app', 'chrome', false)), null);
  assert.equal(installHintFor(r('other', 'browser', 'chrome', true)), null); // desktop: no nagging
  assert.equal(installHintFor(null), null);
});
