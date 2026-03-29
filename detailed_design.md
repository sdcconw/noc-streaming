# 管理画面配信システム 詳細設計書
作成日: 2026-03-07  
更新日: 2026-03-29

## 1. アーキテクチャ

```text
WebUI (Bootstrap)
  └─ nocstream (Node.js 24 / Express)
      ├─ Auth (Local / LDAP)
      ├─ Jobs API
      ├─ Admin API
      ├─ JobWorker Service
      │   ├─ Xvfb
      │   ├─ Chromium
      │   ├─ x11vnc
      │   └─ FFmpeg
      └─ Prisma Client

MySQL 8.4
noVNC(websockify)
```

Docker Composeサービス:

- `mysql`
- `nocstream`
- `novnc`

## 2. 技術スタック

- Node.js 24 / TypeScript
- Express
- Prisma ORM
- MySQL 8.4
- OpenAPI 3.1 + Swagger UI (`/docs`)
- Xvfb / Chromium / FFmpeg / x11vnc
- noVNC (theasp/novnc + websockify token)

## 3. 認証・セッション設計

### 3.1 ログイン

- `POST /api/auth/login`
- 成功時にCookie発行:
  - `noc_access_token` (HttpOnly, SameSite=Strict)
  - `noc_csrf` (SameSite=Strict)

### 3.2 セッション検証

- APIはCookieトークンでセッションDBを検証
- セッション失効/期限切れ/無効ユーザーを拒否

### 3.3 CSRF対策

- `GET/HEAD/OPTIONS` 以外の `/api/*` はCSRF検証対象
- `x-csrf-token` ヘッダと `noc_csrf` Cookieの一致必須
- Bearer認証ヘッダ使用時はCSRFチェック対象外（内部/デバッグ用途）

### 3.4 LDAP

- LDAP有効時、ローカルユーザー不一致時にLDAP認証を試行
- `server_url` は `ldap://` or `ldaps://` のみ許可
- `user_filter` は `{username}` を必須
- `bind_password` はレスポンスで返却しない（`has_bind_password`のみ）

## 4. RBAC

- `admin`: 全操作
- `operator`: ジョブ運用（start/stop/restart/update）
- `viewer`: 参照系のみ

## 5. ジョブ状態遷移

- `STOPPED`
- `STARTING`
- `RUNNING`
- `RECONNECTING`
- `ERROR`
- `STOPPING`

遷移概要:

- Start: `STOPPED -> STARTING -> RUNNING`
- 異常: `RUNNING -> RECONNECTING -> RUNNING/ERROR`
- Stop: `RUNNING -> STOPPING -> STOPPED`

補正:

- API起動時、実プロセス整合のため実行系状態を `STOPPED` に補正

## 6. Worker実行設計

### 6.1 Browser入力

1. Xvfb起動
2. x11vnc起動（必要時）
3. Chromium起動
4. CDP接続、viewport/style適用
5. FFmpegでx11grab配信

### 6.2 Test Pattern入力

- FFmpeg `lavfi` を入力源として配信

### 6.2b SSH Terminal入力

- Xvfb上に `xterm` を起動
- 起動時はログインシェルのみを表示
- `terminal_bg_color` / `terminal_fg_color` を `xterm` の `-bg` / `-fg` に反映
- `terminal_font_size_px` を `xterm` の `-fs` に反映
- `terminal_cols` / `terminal_rows` が未指定時は、解像度と文字サイズから自動算出
- `terminal_cols` / `terminal_rows` が指定されている場合は、その値を優先
- シェル起動時に `stty cols/rows` を適用してCUIアプリ側の端末サイズ認識を合わせる
- 画面は既存の `x11grab` で配信
- SSH接続先コマンドや認証入力はVNC/noVNC経由で利用者が実施
- SSHクライアントの keepalive はアプリ側で自動投入しない

### 6.3 URLローテーション

- `priority` 昇順でURL配列を決定
- 複数URL: ジョブの `refresh_interval_sec`（切替間隔）経過で次URLへ
- 単一URL: URLごとの `refresh_interval_sec`（URL更新間隔）経過で `Page.reload()`
- URLごとの `refresh_interval_sec=0` は `Page.reload()` を実行しない
- 最小10秒

### 6.4 再接続制御

- 従来は障害時に入力側プロセスと出力側プロセスをすべて停止して再起動していた
- 現行実装では、`Browser` / `SSH Terminal` 入力時に `ffmpeg` のみ異常終了した場合、`output_only` モードで復旧する
- `output_only` モードでは以下を維持する
  - `Xvfb`
  - `x11vnc`
  - `Chromium` または `xterm`
- `output_only` モードでは `ffmpeg` のみ停止・再起動する
- `xvfb` / `x11vnc` / `chromium` / `terminal` の異常時は従来どおり全体再起動する
- 復旧ログには `reconnecting ... [mode=output_only|full]` を出力する

### 6.5 shared memory対策

- `x11vnc` は `-noshm -onetile -no6` を付与して起動する
- これにより System V shared memory の利用量を抑制する
- ジョブ起動前に `ipcs -m` を確認し、`nattch=0` の stale shared memory segment を `ipcrm -m` で削除する
- ジョブ停止後にも同様の cleanup を実施する
- 停止処理では即時 `SIGKILL` せず、まず `SIGTERM` 後に終了待ちを行い、未終了時のみ `SIGKILL` を実施する
- cleanup 結果は `shared memory cleanup (...)` としてジョブログへ出力する

## 7. VNC / noVNC設計

### 7.1 VNCポート割当

- `vnc_port = VNC_BASE_PORT + (job_id % VNC_PORT_SPAN)`

### 7.2 noVNC接続

- `novnc` コンテナが token file で中継
- token形式: `job-{id}`
- マッピング先: `nocstream:{vnc_port}`
- APIレスポンスに `novnc_url` を返却

## 8. API設計（主要）

- Auth
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
- Jobs
  - `GET /api/jobs`
  - `POST /api/jobs`
  - `GET /api/jobs/{id}`
  - `PUT /api/jobs/{id}`
  - `DELETE /api/jobs/{id}`
  - `POST /api/jobs/{id}/start|stop|restart`
  - `GET /api/jobs/{id}/status`
  - `GET /api/jobs/{id}/logs`
- Admin
  - `GET/PUT /api/admin/ldap-config`
  - `POST /api/admin/ldap-config/test`
  - `GET/POST /api/admin/users`
  - `PUT/DELETE /api/admin/users/{id}`
  - `GET /api/admin/audit-logs`

## 9. DB設計（主要テーブル）

- `jobs`
- `job_urls`
- `job_events`
- `job_browser_state`
- `users`
- `sessions`
- `ldap_config`
- `audit_logs`

注記:

- `stream_key` / `bind_password` は暗号化保存
- `job_urls.schedule_time` は予約列（現行未使用）
- `jobs` には SSH Terminal 向け設定として以下を保持する
  - `terminal_bg_color`
  - `terminal_fg_color`
  - `terminal_font_size_px`
  - `terminal_cols`
  - `terminal_rows`

## 10. WebUI設計

- ページ構成:
  - ジョブ管理
  - ユーザー管理
  - LDAP設定
  - 監査ログ
- サイドバー + トップバー（ダークモード切替）
- ジョブ作成/編集はタブ構成
  - 基本設定
  - ソース
  - 追加設定
- VNCボタンでnoVNCを新規タブ表示
- ソースタブでは以下を設定できる
  - 入力ソース種別
  - テストパターン
  - テストパラメータ
  - 端末背景色
  - 端末文字色
  - 端末文字サイズ
  - 端末列数
  - 端末行数
  - 画面切替間隔
  - 表示URL一覧

## 11. セキュリティ設計

- Helmet/CSP適用
- HttpOnly Cookieセッション
- CSRFトークン検証
- LDAP機密情報の非返却
- Prisma利用によるSQLインジェクション耐性

## 12. 運用設計

- コンテナ運用: Docker Compose
- OpenAPIでAPI契約を管理
- ログ/監査ログで変更追跡
- 既存ジョブの起動/停止/再起動で配信制御
- `nocstream` コンテナには `shm_size: 4gb` を設定
- Browser/SSH Terminal入力では VNC/noVNC 経由で入力ソース画面へ操作介入可能
