# 管理画面配信システム 要件定義書
作成日: 2026-03-07  
更新日: 2026-03-09

## 1. 目的

NOC向けのWebダッシュボード画面をブラウザ表示し、その画面をRTMP/SRTで継続配信する。  
運用者はWebUIからジョブを管理し、画面切替や配信状態を制御できること。

## 2. システム構成要件

- WebUI（Bootstrap）
- APIサーバー（Node.js 24 / TypeScript）
- DB（MySQL 8.4）
- ORM（Prisma）
- Worker（Xvfb / Chromium / FFmpeg / x11vnc）
- noVNC（Websockify）
- OpenAPI（Swagger UI）

## 3. ジョブ要件

ジョブは以下を保持する。

- 名前
- 解像度（幅・高さ）
- FPS
- Bitrate
- Codec / Preset
- 配信方式（RTMP / SRT）
- 出力先URL
- Stream Key（任意）
- 入力種別（Browser / Test Pattern）
- 表示URLリスト（複数）
- URLごとの `priority` / `refresh_interval_sec`
- 再接続設定（`max_retries` / `retry_interval_sec`）
- オーバーレイ設定（時刻+メッセージ）

## 4. 表示URL動作要件

- 複数URLを設定可能
- 並び順は `priority` 昇順（同一priorityは登録順）
- 複数URL時: 現在URLの `refresh_interval_sec` 経過で次URLへ遷移
- 単一URL時: `refresh_interval_sec` ごとにリロード
- 最小間隔は60秒

## 5. 入力ソース要件

- Browser入力: ChromiumでURL表示しX11キャプチャ
- Test Pattern入力: FFmpeg lavfiパターン生成

## 6. オーバーレイ要件

- 表示形式: `YYYY/MM/DD hh:mm:ss {message}`
- 時刻はサーバー時刻
- 位置: 左上/右上/左下/右下
- 文字サイズ指定可能

## 7. 配信要件

- RTMP対応
- SRT対応（URLパラメータ込み）
- 自動再接続（設定回数/間隔）

## 8. 認証・認可要件

- ローカルユーザー認証
- LDAP認証
- ロール制御:
  - `admin`: 全操作
  - `operator`: ジョブ運用操作
  - `viewer`: 参照のみ

## 9. セキュリティ要件

- セッションはHttpOnly Cookieで保持
- 更新系APIはCSRFトークン検証を必須
- CSP等のセキュリティヘッダを適用
- `JWT_SECRET` / `SECRET_ENCRYPTION_KEY` は必須
- LDAP `bind_password` はAPIで返却しない

## 10. VNC/noVNC要件

- ジョブごとにVNCポートを割当
- noVNCからブラウザのみで接続可能
- WebUIのVNC操作でnoVNC画面を開けること

## 11. 運用要件

- ジョブの作成/編集/削除
- Start/Stop/Restart
- ログ閲覧
- 監査ログ閲覧
- LDAP設定管理
- ローカルユーザー管理

## 12. 非機能要件

- 対象OS: Linuxサーバー（RHEL9系を想定）
- 24/7運用を想定
- 障害時のジョブ単位自動復旧
- スケール目標: 同時100配信（要リソース設計）
