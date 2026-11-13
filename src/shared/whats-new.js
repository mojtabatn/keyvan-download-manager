'use strict';
/*
 * "What's new" texts shown in the window that opens after an update (and from Settings → About).
 * Newest first. Every text has an English and a Persian version.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WHATS_NEW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ENTRIES = [
    {
      version: '0.2.0',
      date: '2026-11-13',
      items: [
        {
          icon: 'globe',
          title: { en: 'Proxy support', fa: 'پشتیبانی از پروکسی' },
          text: {
            en: 'Use an HTTP or SOCKS5 proxy, or the one from your system, with an optional login. It works for downloads, video downloads and update checks. Settings → Proxy.',
            fa: 'از پروکسی HTTP یا SOCKS5 یا پروکسی خود سیستم استفاده کنید، با نام کاربری و رمز اختیاری. برای دانلودها، دانلود ویدیو و بررسی آپدیت کار می‌کند. تنظیمات ← پروکسی.',
          },
        },
        {
          icon: 'lang',
          title: { en: 'Persian language', fa: 'زبان فارسی' },
          text: {
            en: 'KDM now speaks Persian, with a right-to-left layout, Persian digits and the Jalali calendar. Settings → Language.',
            fa: 'KDM حالا فارسی هم بلد است، با چیدمان راست‌به‌چپ، ارقام فارسی و تقویم شمسی. تنظیمات ← زبان.',
          },
        },
        {
          icon: 'clock',
          title: { en: '“Last try” column', fa: 'ستون «آخرین تلاش»' },
          text: {
            en: 'The compact list shows the date and time of each download’s last attempt, so you can see when something was tried or failed.',
            fa: 'لیست فشرده تاریخ و ساعت آخرین تلاش هر دانلود را نشان می‌دهد تا ببینید هر فایل کی امتحان شده یا خطا داده است.',
          },
        },
        {
          icon: 'list',
          title: { en: 'A cleaner list', fa: 'لیست تمیزتر' },
          text: {
            en: 'The lines between downloads are gone, so the list looks calmer.',
            fa: 'خط‌های بین دانلودها برداشته شد تا لیست آرام‌تر دیده شود.',
          },
        },
        {
          icon: 'star',
          title: { en: 'This window', fa: 'همین پنجره' },
          text: {
            en: 'After every update KDM now tells you what changed. You can open it again from Settings → About.',
            fa: 'بعد از هر آپدیت، KDM تغییرات را به شما نشان می‌دهد. از تنظیمات ← درباره هم می‌توانید دوباره بازش کنید.',
          },
        },
      ],
    },
    {
      version: '0.1.3',
      date: '2026-11-12',
      items: [
        {
          icon: 'shield',
          title: { en: 'Security update', fa: 'به‌روزرسانی امنیتی' },
          text: {
            en: 'Browser cookies are encrypted, only KDM’s own extension can send downloads, and the video tools are verified before use.',
            fa: 'کوکی‌های مرورگر رمزگذاری می‌شوند، فقط افزونه‌ی خود KDM می‌تواند دانلود بفرستد و ابزارهای ویدیو قبل از استفاده بررسی می‌شوند.',
          },
        },
      ],
    },
    {
      version: '0.1.2',
      date: '2026-11-12',
      items: [
        {
          icon: 'tool',
          title: { en: 'Fixed old browser downloads reopening', fa: 'رفع باز شدن دانلودهای قدیمی مرورگر' },
          text: {
            en: 'Reopening the browser no longer opens windows for old downloads.',
            fa: 'با باز شدن دوباره‌ی مرورگر دیگر پنجره‌ای برای دانلودهای قدیمی باز نمی‌شود.',
          },
        },
      ],
    },
    {
      version: '0.1.1',
      date: '2026-11-12',
      items: [
        {
          icon: 'list',
          title: { en: 'Queues and multi-select', fa: 'صف‌ها و انتخاب چندتایی' },
          text: {
            en: 'Several download queues, selecting many downloads at once, YouTube downloads fixed and a macOS version.',
            fa: 'چند صف دانلود، انتخاب چند دانلود با هم، رفع مشکل یوتیوب و نسخه‌ی مک.',
          },
        },
      ],
    },
  ];

  const cmp = (a, b) => {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  };

  /** Entries newer than `from` up to and including `to` (only `to` itself when `from` is unknown). */
  function between(from, to) {
    return ENTRIES.filter((e) => (from ? cmp(e.version, from) > 0 && cmp(e.version, to) <= 0 : e.version === to));
  }

  return { ENTRIES, between, cmp };
});
