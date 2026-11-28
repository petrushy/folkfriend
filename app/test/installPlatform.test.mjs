// Install-instruction platform detection (src/js/installPlatform.mjs).
//
// Run with:  node app/test/installPlatform.test.mjs

import assert from 'node:assert/strict';
import { detectInstallPlatform, isInstalled, platformGroup, PLATFORMS } from '../src/js/installPlatform.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

const UA = {
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1',
    iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15',
    iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 323.0.0.35.65',
    iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 [FBAN/FBIOS;FBAV/455.0.0.36.111]',
    ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
    androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
    androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
};

test('iOS browsers', () => {
    assert.equal(detectInstallPlatform({ userAgent: UA.iphoneSafari }), 'ios-safari');
    assert.equal(detectInstallPlatform({ userAgent: UA.iphoneChrome }), 'ios-other');
    assert.equal(detectInstallPlatform({ userAgent: UA.iphoneFirefox }), 'ios-other');
});

test('an iPad that claims to be a Mac is told the iOS steps', () => {
    assert.equal(detectInstallPlatform({ userAgent: UA.ipadAsMac, maxTouchPoints: 5 }), 'ios-safari');
    assert.equal(detectInstallPlatform({ userAgent: UA.ipadAsMac, maxTouchPoints: 0 }), 'desktop-safari',
        'a real Mac has no touch points');
});

test('in-app browsers are told to open a real browser', () => {
    assert.equal(detectInstallPlatform({ userAgent: UA.iphoneInstagram }), 'in-app');
    assert.equal(detectInstallPlatform({ userAgent: UA.iphoneFacebook }), 'in-app');
    assert.equal(detectInstallPlatform({ userAgent: UA.androidWebView }), 'in-app');
});

test('Android browsers', () => {
    assert.equal(detectInstallPlatform({ userAgent: UA.androidChrome }), 'android-chrome');
    assert.equal(detectInstallPlatform({ userAgent: UA.androidSamsung }), 'android-samsung',
        'Samsung Internet also says Chrome, and must not be read as it');
    assert.equal(detectInstallPlatform({ userAgent: UA.androidFirefox }), 'android-firefox');
});

test('desktop browsers', () => {
    assert.equal(detectInstallPlatform({ userAgent: UA.macChrome }), 'desktop-chromium');
    assert.equal(detectInstallPlatform({ userAgent: UA.winEdge }), 'desktop-chromium');
    assert.equal(detectInstallPlatform({ userAgent: UA.macSafari }), 'desktop-safari');
    assert.equal(detectInstallPlatform({ userAgent: UA.winFirefox }), 'desktop-other');
    assert.equal(detectInstallPlatform({}), 'desktop-other', 'no user agent at all still answers');
});

test('installed: display-mode or navigator.standalone', () => {
    assert.equal(isInstalled({}), false);
    assert.equal(isInstalled({ navigatorStandalone: true }), true);
    assert.equal(isInstalled({ matches: q => q === '(display-mode: standalone)' }), true);
    assert.equal(isInstalled({ matches: q => q === '(display-mode: minimal-ui)' }), true);
    assert.equal(isInstalled({ matches: () => { throw new Error('no matchMedia'); } }), false,
        'a throwing matchMedia reads as not installed, never as a crash');
});

test('every platform has a group', () => {
    for (const p of PLATFORMS) assert.ok(['ios', 'android', 'desktop', 'in-app'].includes(platformGroup(p)), p);
});

console.log(`\n${passed} passed`);
