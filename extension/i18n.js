// Language of the extension: it follows the app (the app reports its language when the extension pings it).
(function (g) {
  const FA = {
    'Keyvan Download Manager': 'دانلود منیجر کیوان',
    'Checking…': 'در حال بررسی…',
    'Capture browser downloads': 'گرفتن دانلودهای مرورگر',
    'Skip files smaller than': 'نادیده گرفتن فایل‌های کوچک‌تر از',
    'Capture all': 'همه را بگیر',
    '512 KB': '۵۱۲ کیلوبایت',
    '1 MB': '۱ مگابایت',
    '5 MB': '۵ مگابایت',
    '20 MB': '۲۰ مگابایت',
    'Videos on this page': 'ویدیوهای این صفحه',
    'Download video from this page': 'دانلود ویدیو از این صفحه',
    'Download all links on this page': 'دانلود همه‌ی لینک‌های این صفحه',
    'Right-click any link → “Download with KDM”.': 'روی هر لینک راست‌کلیک کنید ← «دانلود با KDM».',
    'Connected · v{v}': 'متصل · نسخه‌ی {v}',
    'Connected · integration is off in the app': 'متصل · اتصال به مرورگر در برنامه خاموش است',
    'App not running — downloads stay in the browser': 'برنامه اجرا نیست — دانلودها در مرورگر می‌مانند',
    'Sending…': 'در حال ارسال…',
    'KDM isn’t running': 'KDM اجرا نیست',
    'Sent to KDM ✓': 'به KDM فرستاده شد ✓',
    'Download video': 'دانلود ویدیو',
    'Download this video with KDM': 'دانلود این ویدیو با KDM',
    'Download with KDM': 'دانلود با KDM',
    'Download this media with KDM': 'دانلود این رسانه با KDM',
    'Download all links with KDM': 'دانلود همه‌ی لینک‌ها با KDM',
  };
  let lang = 'en';
  const api = {
    /** Reads the language the app last reported. */
    async init() {
      try {
        lang = (await chrome.storage.local.get('lang')).lang === 'fa' ? 'fa' : 'en';
      } catch {
        /* no storage: English */
      }
      return lang;
    },
    lang: () => lang,
    isRtl: () => lang === 'fa',
    t(key, vars) {
      let s = lang === 'fa' && FA[key] ? FA[key] : key;
      if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, vars[k]);
      return s;
    },
    digits: (s) => (lang === 'fa' ? String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]) : String(s)),
    /** Translates a page's fixed text (text nodes that are exactly a known sentence). */
    translateDom(root) {
      if (lang !== 'fa') return;
      document.documentElement.dir = 'rtl';
      document.documentElement.lang = 'fa';
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (w.nextNode()) nodes.push(w.currentNode);
      for (const n of nodes) {
        const raw = n.nodeValue.trim();
        if (raw && FA[raw]) n.nodeValue = n.nodeValue.replace(raw, FA[raw]);
      }
    },
  };
  g.KDM_I18N = api;
})(typeof self !== 'undefined' ? self : this);
