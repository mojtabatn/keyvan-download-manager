'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const I18N = require('../src/shared/i18n');
const WHATS_NEW = require('../src/shared/whats-new');

// load the Persian dictionary into the shared module
require('../src/shared/locale-fa');

test('English is the key: a missing translation shows the English text', () => {
  I18N.setLang('en');
  assert.strictEqual(I18N.t('Add Link'), 'Add Link');
  assert.strictEqual(I18N.t('{n} waiting', { n: 3 }), '3 waiting');
  I18N.setLang('fa');
  assert.strictEqual(I18N.t('Add Link'), 'افزودن لینک');
  assert.strictEqual(I18N.t('A text nobody translated'), 'A text nobody translated');
  assert.strictEqual(I18N.t('{n} waiting', { n: '۳' }), '۳ در انتظار');
  I18N.setLang('en');
});

test('language follows the system locale, English otherwise', () => {
  assert.strictEqual(I18N.fromLocale('fa-IR'), 'fa');
  assert.strictEqual(I18N.fromLocale('fa'), 'fa');
  assert.strictEqual(I18N.fromLocale('en-US'), 'en');
  assert.strictEqual(I18N.fromLocale('de'), 'en');
  assert.strictEqual(I18N.fromLocale(''), 'en');
});

test('Persian uses Persian digits, the Jalali calendar and right-to-left', () => {
  I18N.setLang('fa');
  assert.strictEqual(I18N.digits('1.9 MB 64.00'), '۱٫۹ MB ۶۴٫۰۰');
  assert.strictEqual(I18N.dir(), 'rtl');
  // 13 Nov 2026 07:26 UTC is 22 Aban 1405
  assert.match(I18N.dateTime(Date.UTC(2026, 10, 13, 12, 0)), /^۱۴۰۵\/۰۸\/۲۲ /);
  I18N.setLang('en');
  assert.strictEqual(I18N.digits('1.9 MB'), '1.9 MB');
  assert.strictEqual(I18N.dir(), 'ltr');
  assert.match(I18N.dateTime(Date.UTC(2026, 10, 13, 12, 0)), /^2026-11-13 \d\d:\d\d$/);
  assert.strictEqual(I18N.dateTime(0), '—');
});

test('every text in the app has a Persian translation', () => {
  // scripts/i18n-keys.js scans the code and the HTML pages and exits 1 when something is missing
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'i18n-keys.js')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    assert.fail(`Missing Persian translations:\n${e.stdout}`);
  }
});

test('a translation keeps every {placeholder} of its English text', () => {
  // the dictionary is registered under 'fa'; read it back through t()
  I18N.setLang('fa');
  const keys = [...require('fs').readFileSync(path.join(__dirname, '..', 'src', 'shared', 'locale-fa.js'), 'utf8').matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"):/gm)].map((m) => (m[1] ?? m[2]).replace(/\\'/g, "'"));
  assert.ok(keys.length > 300, `found ${keys.length} entries`);
  for (const k of keys) {
    const want = (k.match(/\{\w+\}/g) || []).sort().join();
    const got = (I18N.t(k).match(/\{\w+\}/g) || []).sort().join();
    assert.strictEqual(got, want, `placeholders differ in: ${k}`);
    assert.ok(I18N.has(k));
  }
  I18N.setLang('en');
});

test('"What\'s new" has English and Persian text for every entry', () => {
  for (const e of WHATS_NEW.ENTRIES) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    for (const it of e.items) {
      for (const f of ['title', 'text']) {
        assert.ok(it[f].en && it[f].fa, `${e.version} ${f}`);
        assert.match(it[f].fa, /[\u0600-\u06FF]/, 'Persian text contains Persian letters');
      }
    }
  }
  assert.deepStrictEqual(WHATS_NEW.between('0.1.3', '0.2.0').map((e) => e.version), ['0.2.0']);
  assert.deepStrictEqual(WHATS_NEW.between('0.2.0', '0.2.0'), []);
  assert.deepStrictEqual(WHATS_NEW.between(null, '0.2.0').map((e) => e.version), ['0.2.0']);
});
