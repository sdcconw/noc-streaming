// OFFLINE設定に応じてBootstrap系CSSの読み込み元を切り替える。
(() => {
  const offline = Boolean(window.__NOC_RUNTIME__?.offline);
  const cssList = offline
    ? [
        '/ui/vendor/bootstrap/css/bootstrap.min.css',
        '/ui/vendor/bootstrap-icons/font/bootstrap-icons.min.css'
      ]
    : [
        'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
        'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css'
      ];

  for (const href of cssList) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
})();
