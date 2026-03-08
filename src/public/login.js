// ログイン画面の送信処理とエラーメッセージ表示を行うスクリプト。
const form = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');

// ログインフォーム送信時に認証APIを呼び出し、成功時はジョブ画面へ遷移する。
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError?.classList.add('d-none');

  const username = document.getElementById('username')?.value.trim() ?? '';
  const password = document.getElementById('password')?.value ?? '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      throw new Error('ログインに失敗しました');
    }

    await res.json();
    location.href = '/ui/jobs.html';
  } catch (err) {
    if (!loginError) return;
    loginError.textContent = err instanceof Error ? err.message : 'ログインに失敗しました';
    loginError.classList.remove('d-none');
  }
});
