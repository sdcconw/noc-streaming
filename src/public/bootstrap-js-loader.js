// OFFLINE設定に応じてBootstrap JSの読み込み元を切り替える。
(() => {
  const offline = Boolean(window.__NOC_RUNTIME__?.offline);
  const src = offline
    ? '/ui/vendor/bootstrap/js/bootstrap.bundle.min.js'
    : 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js';

  // app.js側で待機できるよう、ロード完了Promiseを公開する。
  window.__bootstrapReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error(`bootstrap load failed: ${src}`));
    document.head.appendChild(script);
  });
})();
