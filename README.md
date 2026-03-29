# noc-streaming

NOC画面をブラウザで描画し、FFmpegでRTMP/SRT配信するシステムです。  
Node.js 24 + MySQL 8.4 + Prisma + OpenAPI(Swagger) 構成です。

## 主な機能

- ジョブ作成/編集/削除、開始/停止/再起動
- Browser入力（Xvfb + Chromium + x11grab）
- Test Pattern入力（lavfi）
- SSH Terminal入力（Xvfb + xterm + x11grab、背景色/文字色・文字サイズ・列数・行数設定可、接続操作はVNC/noVNCから手入力）
- URL複数設定とローテーション表示（`priority` + `refresh_interval_sec`）
- 配信先: RTMP / SRT
- オーバーレイ表示（`YYYY/MM/DD hh:mm:ss {message}`、4隅、文字サイズ）
- 認証: ローカルDB + LDAP
- RBAC: `admin` / `operator` / `viewer`
- VNC / noVNC でブラウザ画面確認
- `URL_REFRESH_SEC=0` で URL 自動リロード無効化
- SRT/RTMP 出力断時、Browser/SSH Terminal入力では FFmpeg 出力のみ再接続して入力画面を維持
- `x11vnc` の shared memory 使用抑制と stale SHM cleanup による安定化

## セキュリティ実装

- セッション: HttpOnly Cookie (`noc_access_token`)
- CSRF対策: `noc_csrf` Cookie + `x-csrf-token` ヘッダ（二重送信）
- XSS対策: `helmet` + CSP
- LDAP機密: `bind_password` はAPIレスポンスで返却しない（`has_bind_password`のみ）
- 機密設定: `JWT_SECRET`, `SECRET_ENCRYPTION_KEY` 必須

## セットアップ（Docker Compose）

```bash
cd /root/noc-streaming
cp .env.example .env
# .env の JWT_SECRET / SECRET_ENCRYPTION_KEY を必ず変更
docker compose up -d --build --remove-orphans
```

確認URL:

- Web UI: `http://localhost:3000/ui/`
- Swagger UI: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`
- noVNC: `http://localhost:6080/vnc.html`

## SSH Terminal 運用

- SSH Terminal ジョブは、空のログインシェルを `xterm` で起動します
- 接続先への `ssh ...` 入力、パスワード入力、端末操作は noVNC/VNC 経由で実施します
- WebUI から以下を設定できます
  - 背景色
  - 文字色
  - 文字サイズ(px)
  - 列数(任意)
  - 行数(任意)
- 全画面 CUI アプリがはみ出す場合は、文字サイズを下げるか、列数・行数を明示指定してください
- SSH 接続自体の keepalive は自動設定していません。必要に応じて利用者が `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ...` のように指定してください

## よく使う操作

RBAC検証ユーザー投入（任意）:

```bash
docker compose exec nocstream npm run seed:users
```

停止:

```bash
docker compose down
```

データ含めて削除:

```bash
docker compose down -v
```

## 認証API利用例（Cookie + CSRF）

ログイン:

```bash
curl -sS -c /tmp/noc.cookie -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"password"}'
```

参照系GET:

```bash
curl -sS -b /tmp/noc.cookie http://localhost:3000/api/jobs
```

更新系POST（CSRF必須）:

```bash
CSRF=$(awk '$6=="noc_csrf" {print $7}' /tmp/noc.cookie)
curl -sS -b /tmp/noc.cookie -X POST http://localhost:3000/api/jobs/1/restart \
  -H "x-csrf-token: $CSRF"
```

## 表示URL入力形式

WebUIでは1行1URLで以下形式です。

- `URL,PRIORITY,URL_REFRESH_SEC`
- 例: `https://example.local/dashboard,1,60`

動作:

- `priority` 昇順（同値は登録順）で並び替え
- 複数URL: ジョブの `refresh_interval_sec`（画面切替間隔）で次URLへ遷移
- URLごと: `URL_REFRESH_SEC` ごとに再読込（`0` は再読込しない）

例:

- `https://first.local,1,1800`
- `https://second.local,2,3600`

この場合、画面切替間隔が 30 秒なら 30 秒ごとに画面を切り替えつつ、それぞれの URL は 1800 秒 / 3600 秒ごとに独立して再読込されます。

## 環境変数

詳細は `.env.example` を参照してください。主な必須項目:

- `DATABASE_URL`
- `JWT_SECRET`
- `SECRET_ENCRYPTION_KEY`

## 補足

- VNCポート割当: `VNC_BASE_PORT + (job_id % VNC_PORT_SPAN)`
- noVNCは `job-{id}` トークンで `nocstream:{vnc_port}` に接続
- API再起動時は実行中ステータス整合のためジョブ状態を `STOPPED` に補正
- `x11vnc` は `-noshm -onetile -no6` 付きで起動し、System V shared memory の消費を抑制
- ジョブ停止時と再起動時に、`nattch=0` の stale shared memory segment を cleanup
- Browser/SSH Terminal入力では、`ffmpeg` のみ異常終了した場合は `output_only` モードで再接続し、入力側プロセスを維持
