// Lists the texts in the source that have no Persian translation yet.
// Usage: node scripts/i18n-keys.js [--all]   (exit code 1 when something is missing)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const I18N = require('../src/shared/i18n');
require('../src/shared/locale-fa');
require('../src/shared/whats-new');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every string literal inside the call t( ... ), including both sides of a "? :". */
function literalsInCalls(src) {
  const keys = [];
  const re = /(^|[^\w$.])t\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += c === '`' ? 1 : src[j] === '\\' ? 2 : 1;
        i = j;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    // only the part before the options object ({ n: ... }) holds the keys
    for (const lit of body.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const v = (lit[1] ?? lit[2]).replace(/\\'/g, "'");
      if (/[A-Za-z]/.test(v)) keys.push(v);
    }
  }
  return keys;
}

const found = new Map(); // key -> first place
const add = (k, where) => k && !found.has(k) && found.set(k, where);

for (const f of walk(path.join(root, 'src')).filter((p) => p.endsWith('.js') && !/shared[\\/](locale-|i18n)/.test(p) && !/whats-new/.test(p))) {
  const rel = path.relative(root, f);
  for (const k of literalsInCalls(fs.readFileSync(f, 'utf8'))) add(k, rel);
}
// texts given to el(..., { text / title / placeholder }) and the Settings rows: translated automatically by el()
function propLiterals(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:text|title|placeholder|checkboxLabel):\s*'((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]);
  for (const m of src.matchAll(/\b(?:row|group)\(\s*'((?:[^'\\\n]|\\.)*)'(?:\s*,\s*(?:'[^']*',\s*)?'((?:[^'\\\n]|\\.)*)')?/g)) out.push(m[1], m[2]);
  for (const m of src.matchAll(/\[\s*(?:[\w'-]+),\s*'((?:[^'\\\n]|\\.)*)'\s*\]/g)) out.push(m[1]); // select options [value, 'Label']
  for (const m of src.matchAll(/\.(?:textContent|placeholder)\s*=\s*'((?:[^'\\\n]|\\.)*)'/g)) out.push(m[1]);
  return out.filter((v) => v && /[A-Za-z]{2}/.test(v) && (!/^[\w-]+$/.test(v) || /^[A-Z][a-z]+$/.test(v)) && !/^(assets|#|\.|height|margin|width|flex|padding|background)/.test(v));
}
for (const f of walk(path.join(root, 'src', 'renderer')).filter((p) => p.endsWith('.js'))) {
  const rel = path.relative(root, f);
  for (const k of propLiterals(fs.readFileSync(f, 'utf8'))) add(k.replace(/\\'/g, "'"), rel);
}

// fixed text in the HTML pages
for (const f of walk(path.join(root, 'src', 'renderer')).filter((p) => p.endsWith('.html'))) {
  const rel = path.relative(root, f);
  const html = fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '');
  for (const m of html.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)) add(m[1].replace(/\s+/g, ' ').trim(), rel);
  for (const m of html.matchAll(/\b(?:title|placeholder|alt|aria-label|data-tip)="([^"]*[A-Za-z][^"]*)"/g)) add(m[1], rel);
}

const ignore = /^(\d+ (links?|KB\/s|MB\/s)|KDM|Version \d[\d.]*|ffmpeg|yt-dlp|ytdlp|MP3|HLS|DASH|Ctrl\+V|⌘[NV]|edge:\/\/extensions|chrome:\/\/extensions|canceled|completed|connecting|downloading|error|info|media|unknown|download|and|MB\.|Keyvan Download Manager Version.*)$/;
// Day names, themes and other texts reached through arrays or variables
const EXTRA = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Main queue', 'queue', 'B', 'KB', 'MB', 'GB', 'TB', 'sec', 's'];
for (const k of EXTRA) add(k, 'extra');
const missing = [...found].filter(([k]) => !ignore.test(k) && !I18N.has('fa') && true);
I18N.setLang('fa');
const need = [...found].filter(([k]) => !ignore.test(k) && !I18N.has(k));
if (process.argv.includes('--all')) for (const [k, w] of found) console.log(`${I18N.has(k) ? 'ok ' : '-- '} ${w}  ${k}`);
else for (const [k, w] of need) console.log(`${w}\t${k}`);
console.error(`${found.size} texts, ${need.length} without Persian`);
process.exit(need.length ? 1 : 0);
