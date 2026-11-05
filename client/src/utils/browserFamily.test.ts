import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChromiumBrowser } from './browserFamily';

test('Chromium-family browsers are recognized by client hints or user agent', () => {
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(isChromiumBrowser({ userAgent: chrome, userAgentData: { brands: [{ brand: 'Not)A;Brand' }, { brand: 'Chromium' }, { brand: 'Brave' }] } }), true);
  assert.equal(isChromiumBrowser({ userAgent: chrome, userAgentData: { brands: [{ brand: 'Microsoft Edge' }] } }), true);
  assert.equal(isChromiumBrowser({ userAgent: chrome }), true, 'Vivaldi and older Chromium without client hints');
  assert.equal(isChromiumBrowser({ userAgent: `${chrome} Edg/140.0.0.0` }), true);
  assert.equal(isChromiumBrowser(undefined), true, 'no navigator: no notice');
});

test('Firefox and Safari are not Chromium-family browsers', () => {
  assert.equal(isChromiumBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0' }), false);
  assert.equal(isChromiumBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15' }), false);
  assert.equal(isChromiumBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/144.0 Chrome/1' }), false, 'a Firefox user agent that mentions Chrome');
  assert.equal(isChromiumBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/144.0', userAgentData: { brands: [] } }), false);
});
