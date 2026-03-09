// OFFLINE設定に応じてBootstrap JSの読み込み元を切り替える。
(() => {
  const offline = Boolean(window.__NOC_RUNTIME__?.offline);
  const src = offline
    ? '/ui/vendor/bootstrap/js/bootstrap.bundle.min.js'
    : 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js';

  // 解析順序を維持するためにdocument.writeで同期的に読み込む。
  document.write(`<script src="${src}"><\\/script>`);
})();
