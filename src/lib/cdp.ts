// Chrome DevTools Protocol との通信を行う最小クライアント実装。
import WebSocket from 'ws';
import type { RawData } from 'ws';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export class CdpClient {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: unknown };
        if (!msg.id) return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      } catch {
        // ignore parse errors
      }
    });
  }

  // 指定ポートのCDPエンドポイントへ接続し、必要ドメインを有効化する。
  static async connect(debugPort: number): Promise<CdpClient> {
    const wsUrl = await resolveWsUrl(debugPort);
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(wsUrl);
      s.once('open', () => resolve(s));
      s.once('error', reject);
    });

    const c = new CdpClient(ws);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Network.enable');
    return c;
  }

  // WebSocket接続をクローズする。
  async close() {
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  // ブラウザタブを指定URLへ遷移させる。
  async navigate(url: string) {
    await this.send('Page.navigate', { url });
  }

  // キャプチャ用のビューポートサイズを設定する。
  async setViewport(width: number, height: number) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  // 余白とカーソルを抑止するキャプチャ用CSSを適用する。
  async applyCaptureStyle() {
    const script = `
(() => {
  const styleId = 'noc-capture-style';
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    style.textContent = \`
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #000 !important;
        cursor: none !important;
      }
      * { cursor: none !important; }
    \`;
    document.documentElement.appendChild(style);
  }

  const root = document.documentElement;
  const body = document.body;
  const contentWidth = Math.max(
    root ? root.scrollWidth : 0,
    body ? body.scrollWidth : 0,
    root ? root.clientWidth : 0,
    window.innerWidth || 0
  );
  if (contentWidth > window.innerWidth && window.innerWidth > 0) {
    root.style.zoom = String(window.innerWidth / contentWidth);
  } else if (root) {
    root.style.zoom = '1';
  }
  return 'ok';
})();`;
    await this.send('Runtime.evaluate', { expression: script });
  }

  // ブラウザページをキャッシュ無視で再読込する。
  async reload() {
    await this.send('Page.reload', { ignoreCache: true });
  }

  // ログイン維持用途のCookieをブラウザへ注入する。
  async setCookies(cookies: unknown[]) {
    if (!cookies.length) return;
    await this.send('Network.setCookies', { cookies });
  }

  // 現在のブラウザCookie一覧を取得する。
  async getCookies(): Promise<unknown[]> {
    const result = (await this.send('Network.getAllCookies')) as { cookies?: unknown[] };
    return result.cookies ?? [];
  }

  // 汎用CDPコマンドを送信して応答を待つ。
  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    const payload = JSON.stringify({ id, method, params });
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err?: Error) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    return result;
  }
}

// CDPのWebSocket URLを`/json/list`→`/json/version`の順で解決する。
async function resolveWsUrl(port: number): Promise<string> {
  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (listRes.ok) {
    const targets = (await listRes.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const page = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  }

  const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!versionRes.ok) throw new Error(`cdp endpoint not ready: ${versionRes.status}`);
  const body = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('webSocketDebuggerUrl not found');
  return body.webSocketDebuggerUrl;
}
