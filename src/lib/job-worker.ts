// ブラウザ描画・VNC・FFmpegを制御して配信ジョブを実行するワーカー本体。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { JobStatus, type Job, type JobUrl } from '@prisma/client';

import { CdpClient } from './cdp.js';
import { prisma } from './prisma.js';
import { decryptSecret } from './secrets.js';

const execFileAsync = promisify(execFile);

type WorkerMode = 'mock' | 'real';
type WorkerProc = {
  xvfb?: ChildProcessWithoutNullStreams;
  vnc?: ChildProcessWithoutNullStreams;
  chromium?: ChildProcessWithoutNullStreams;
  ffmpeg?: ChildProcessWithoutNullStreams;
};

type UrlTab = {
  targetId: string;
  cdp: CdpClient;
  url: string;
};

type JobRuntime = {
  jobId: bigint;
  mode: WorkerMode;
  displayNum: number;
  captureWidth: number;
  captureHeight: number;
  vncPort: number;
  processes: WorkerProc;
  retries: number;
  stopping: boolean;
  lock: Promise<void>;
  refreshTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  currentUrl?: string;
  currentUrlId?: bigint;
  switchIntervalSec?: number;
  currentRefreshIntervalSec?: number;
  debugPort: number;
  cdp?: CdpClient;
  urlTabs: Map<bigint, UrlTab>;
  lastSwitchAt?: number;
  lastBitrateKbps?: number;
  lastMetricAt?: number;
  currentInputSourceType?: 'browser' | 'test_pattern';
  urlLastReloadAt: Map<bigint, number>;
};

type JobWithUrls = Job & { urls: JobUrl[] };

const workerMode = (process.env.WORKER_MODE ?? 'mock') as WorkerMode;
const monitorIntervalMs = Number(process.env.WORKER_MONITOR_INTERVAL_MS ?? 5000);
const workerVncEnabled = (process.env.WORKER_VNC_ENABLED ?? 'true').toLowerCase() === 'true';
const vncBasePort = Number(process.env.VNC_BASE_PORT ?? 15900);
const vncPortSpan = Math.max(1, Number(process.env.VNC_PORT_SPAN ?? 50));
const START_TIMEOUT_XVFB_MS = 10_000;
const START_TIMEOUT_VNC_MS = 10_000;
const START_TIMEOUT_CHROMIUM_MS = 30_000;
const START_TIMEOUT_FFMPEG_MS = 20_000;
const URL_SWITCH_TIMEOUT_MS = 10_000;
const MIN_REFRESH_SEC = 10;

class JobWorkerService {
  private runtimes = new Map<bigint, JobRuntime>();

  // 全ジョブのヘルス監視ループを開始する。
  public startMonitor() {
    setInterval(() => {
      void this.monitorHealth();
    }, monitorIntervalMs);
  }

  // 指定ジョブの配信パイプラインを起動する。
  public async start(jobId: bigint): Promise<void> {
    const runtime = await this.getOrCreateRuntime(jobId);
    await this.withLock(runtime, async () => {
      const job = await this.loadJob(jobId);
      if (!job) throw new Error('job not found');

      if (this.isRunning(runtime)) {
        await this.log(jobId, 'info', 'worker', 'start skipped: already running');
        return;
      }

      runtime.stopping = false;
      runtime.retries = 0;
      await this.updateStatus(jobId, JobStatus.STARTING);
      await this.log(jobId, 'info', 'worker', `starting job (mode=${runtime.mode})`);

      try {
        await this.startPipeline(runtime, job);
        await this.updateStatus(jobId, JobStatus.RUNNING);
        await this.log(jobId, 'info', 'worker', 'job started');
      } catch (err) {
        await this.log(jobId, 'error', 'worker', `start failed: ${String(err)}`);
        await this.updateStatus(jobId, JobStatus.ERROR);
        await this.stopProcesses(runtime, true);
        throw err;
      }
    });
  }

  // 指定ジョブの配信パイプラインを停止する。
  public async stop(jobId: bigint): Promise<void> {
    const runtime = await this.getOrCreateRuntime(jobId);
    await this.withLock(runtime, async () => {
      const job = await this.loadJob(jobId);
      if (!job) throw new Error('job not found');

      runtime.stopping = true;
      await this.updateStatus(jobId, JobStatus.STOPPING);
      await this.log(jobId, 'info', 'worker', 'stopping job');

      await this.stopProcesses(runtime, false);

      await this.updateStatus(jobId, JobStatus.STOPPED);
      await this.log(jobId, 'info', 'worker', 'job stopped');
    });
  }

  // 指定ジョブを停止後に再起動する。
  public async restart(jobId: bigint): Promise<void> {
    await this.stop(jobId);
    await this.start(jobId);
  }

  // 指定ジョブのイベントログを取得する。
  public async getLogs(jobId: bigint, limit = 200) {
    return prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit
    });
  }

  // 実行中ジョブのプロセス状態を監視し異常時に復旧処理へ移行する。
  private async monitorHealth() {
    for (const [jobId, runtime] of this.runtimes) {
      if (runtime.stopping) continue;
      if (!this.isRunning(runtime)) continue;

      if (runtime.mode === 'real') {
        const browserMode = (runtime.currentInputSourceType ?? 'browser') === 'browser';
        const missing = browserMode
          ? !runtime.processes.xvfb ||
            (workerVncEnabled && !runtime.processes.vnc) ||
            !runtime.processes.chromium ||
            !runtime.processes.ffmpeg ||
            runtime.processes.xvfb.killed ||
            (workerVncEnabled && Boolean(runtime.processes.vnc?.killed)) ||
            runtime.processes.chromium.killed ||
            runtime.processes.ffmpeg.killed
          : !runtime.processes.ffmpeg || runtime.processes.ffmpeg.killed;

        if (missing) {
          await this.handleFailure(runtime, 'process health check detected failure');
        }

        await this.collectRuntimeMetrics(runtime).catch(() => undefined);
      }
    }
  }

  // ジョブ障害発生時の再接続リトライ制御を行う。
  private async handleFailure(runtime: JobRuntime, reason: string) {
    if (runtime.stopping) return;

    const job = await this.loadJob(runtime.jobId);
    if (!job) return;

    await this.log(runtime.jobId, 'error', 'worker', `runtime failure: ${reason}`);

    if (runtime.retries >= job.maxRetries) {
      await this.stopProcesses(runtime, true);
      await this.updateStatus(runtime.jobId, JobStatus.ERROR);
      await this.log(runtime.jobId, 'error', 'worker', 'retry exhausted, moved to ERROR');
      return;
    }

    runtime.retries += 1;
    await this.updateStatus(runtime.jobId, JobStatus.RECONNECTING);
    await this.stopProcesses(runtime, true);

    const waitMs = job.retryIntervalSec * 1000;
    await this.log(
      runtime.jobId,
      'warn',
      'worker',
      `reconnecting in ${job.retryIntervalSec}s (${runtime.retries}/${job.maxRetries})`
    );

    runtime.reconnectTimer = setTimeout(() => {
      void this.withLock(runtime, async () => {
        const latest = await this.loadJob(runtime.jobId);
        if (!latest || runtime.stopping) return;

        try {
          await this.updateStatus(runtime.jobId, JobStatus.STARTING);
          await this.startPipeline(runtime, latest);
          await this.updateStatus(runtime.jobId, JobStatus.RUNNING);
          await this.log(runtime.jobId, 'info', 'worker', 'reconnect succeeded');
        } catch (err) {
          await this.log(runtime.jobId, 'error', 'worker', `reconnect failed: ${String(err)}`);
          await this.handleFailure(runtime, 'reconnect attempt failed');
        }
      });
    }, waitMs);
  }

  // ソース起動からFFmpeg出力開始までの配信パイプラインを構築する。
  private async startPipeline(runtime: JobRuntime, job: JobWithUrls) {
    runtime.currentInputSourceType = job.inputSourceType;
    runtime.captureWidth = job.resolutionWidth;
    runtime.captureHeight = job.resolutionHeight;
    const current = this.resolvePrimaryUrl(job) ?? job.urls[0];
    runtime.currentUrl = current?.url ?? 'about:blank';
    runtime.currentUrlId = current?.id;
    runtime.switchIntervalSec = Math.max(job.refreshIntervalSec ?? MIN_REFRESH_SEC, MIN_REFRESH_SEC);
    const positiveUrlSecs = job.urls
      .map((u) => u.refreshIntervalSec)
      .filter((sec) => sec > 0)
      .map((sec) => Math.max(sec, MIN_REFRESH_SEC));
    runtime.currentRefreshIntervalSec = Math.max(
      MIN_REFRESH_SEC,
      Math.min(runtime.switchIntervalSec, ...(positiveUrlSecs.length ? positiveUrlSecs : [runtime.switchIntervalSec]))
    );
    runtime.lastSwitchAt = Date.now();
    if (current?.id) {
      runtime.urlLastReloadAt.set(current.id, Date.now());
    }

    if (runtime.mode === 'mock') {
      await this.log(
        runtime.jobId,
        'info',
        'mock',
        `mock start: source=${runtime.currentInputSourceType} url=${runtime.currentUrl} (switch=${runtime.currentRefreshIntervalSec}s)`
      );
      this.startTimers(runtime, job.id, runtime.currentRefreshIntervalSec);
      return;
    }

    let inputArgs: string[];
    let inputEnv: Record<string, string> = {};

    if (job.inputSourceType === 'browser') {
      runtime.processes.xvfb = this.spawnProcess(
        runtime,
        'xvfb',
        'Xvfb',
        [
          `:${runtime.displayNum}`,
          '-screen',
          '0',
          `${job.resolutionWidth}x${job.resolutionHeight}x24`,
          '-nolisten',
          'tcp'
        ],
        {}
      );
      await this.waitProcessHealthy(runtime.processes.xvfb, START_TIMEOUT_XVFB_MS, 'xvfb');

      if (workerVncEnabled) {
        runtime.processes.vnc = this.spawnProcess(
          runtime,
          'vnc',
          'x11vnc',
          [
            '-display',
            `:${runtime.displayNum}`,
            '-rfbport',
            String(runtime.vncPort),
            '-forever',
            '-shared',
            '-nopw',
            '-noxdamage',
            '-xkb'
          ],
          {}
        );
        await this.waitProcessHealthy(runtime.processes.vnc, START_TIMEOUT_VNC_MS, 'vnc');
      }

      await this.sleep(500);

      runtime.processes.chromium = this.spawnProcess(
        runtime,
        'chromium',
        'chromium',
        [
          `--remote-debugging-port=${runtime.debugPort}`,
          `--user-data-dir=/tmp/noc-chrome-${runtime.jobId}`,
          `--window-size=${runtime.captureWidth},${runtime.captureHeight}`,
          '--window-position=0,0',
          '--kiosk',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--disable-session-crashed-bubble',
          '--disable-infobars',
          'about:blank'
        ],
        { DISPLAY: `:${runtime.displayNum}` }
      );
      await this.waitProcessHealthy(runtime.processes.chromium, START_TIMEOUT_CHROMIUM_MS, 'chromium');
      await this.ensureBrowserTabs(runtime, job);
      await this.restoreCookies(runtime);
      await this.refreshAllTabs(runtime, job, true);
      await this.activateCurrentUrl(runtime, runtime.currentUrlId);

      await this.sleep(700);
      inputArgs = [
        '-f',
        'x11grab',
        '-draw_mouse',
        '0',
        '-video_size',
        `${job.resolutionWidth}x${job.resolutionHeight}`,
        '-framerate',
        String(job.fps),
        '-i',
        `:${runtime.displayNum}.0`
      ];
      inputEnv = { DISPLAY: `:${runtime.displayNum}` };
    } else {
      const patternType = (job.testPatternType ?? 'testsrc2').trim() || 'testsrc2';
      const params = (job.testPatternParams ?? '').trim();
      const basePattern = `${patternType}=size=${job.resolutionWidth}x${job.resolutionHeight}:rate=${job.fps}`;
      const pattern = params ? `${basePattern}:${params.replace(/^:+/, '')}` : basePattern;
      inputArgs = ['-re', '-f', 'lavfi', '-i', pattern];
      await this.log(runtime.jobId, 'info', 'worker', `test pattern source: ${pattern}`);
    }

    const target = this.buildOutputTarget(job);
    const format = job.protocol === 'rtmp' ? 'flv' : 'mpegts';
    const vf = this.buildVideoFilter(job);

    const ffmpegArgs = [
      ...inputArgs,
      '-c:v',
      job.codec,
      '-preset',
      job.preset,
      '-b:v',
      `${job.bitrateKbps}k`,
      '-vf',
      vf,
      // Keep output broadly compatible with H.264 receivers.
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(Math.max(job.fps * 2, 2)),
      '-keyint_min',
      String(Math.max(job.fps * 2, 2))
    ];

    if (job.codec === 'libx264') {
      ffmpegArgs.push('-profile:v', 'main');
      ffmpegArgs.push('-x264-params', 'repeat-headers=1:scenecut=0:bframes=0');
    }

    ffmpegArgs.push('-f', format, target);

    runtime.processes.ffmpeg = this.spawnProcess(
      runtime,
      'ffmpeg',
      'ffmpeg',
      ffmpegArgs,
      inputEnv
    );
    await this.waitProcessHealthy(runtime.processes.ffmpeg, START_TIMEOUT_FFMPEG_MS, 'ffmpeg');

    if (job.inputSourceType === 'browser') {
      this.startTimers(runtime, job.id, runtime.currentRefreshIntervalSec);
    } else {
      this.clearTimers(runtime);
    }
  }

  // ジョブ関連プロセスとタイマーを停止・後始末する。
  private async stopProcesses(runtime: JobRuntime, forceOnly: boolean) {
    this.clearTimers(runtime);

    const procs: ChildProcessWithoutNullStreams[] = [];
    if (runtime.processes.ffmpeg) procs.push(runtime.processes.ffmpeg);
    if (runtime.processes.chromium) procs.push(runtime.processes.chromium);
    if (runtime.processes.vnc) procs.push(runtime.processes.vnc);
    if (runtime.processes.xvfb) procs.push(runtime.processes.xvfb);

    await this.persistCookies(runtime).catch(() => undefined);
    const clients = new Set<CdpClient>([...runtime.urlTabs.values()].map((x) => x.cdp));
    if (runtime.cdp) clients.add(runtime.cdp);
    for (const cdp of clients) {
      await cdp.close().catch(() => undefined);
    }
    runtime.urlTabs.clear();
    runtime.cdp = undefined;
    runtime.processes = {};

    for (const proc of procs) {
      try {
        if (!forceOnly) {
          proc.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    }

    await this.sleep(300);

    for (const proc of procs) {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }

  // URL更新タイマーを初期化して起動する。
  private startTimers(runtime: JobRuntime, jobId: bigint, refreshIntervalSec: number) {
    this.clearTimers(runtime);
    this.setRefreshTimer(runtime, jobId, refreshIntervalSec);
  }

  // 指定秒間隔でURL更新タイマーを設定する。
  private setRefreshTimer(runtime: JobRuntime, jobId: bigint, refreshIntervalSec: number) {
    if (runtime.refreshTimer) {
      clearInterval(runtime.refreshTimer);
    }

    const sec = Math.max(refreshIntervalSec, MIN_REFRESH_SEC);
    runtime.currentRefreshIntervalSec = sec;
    runtime.refreshTimer = setInterval(() => {
      void this.runRefreshTick(runtime, jobId);
    }, sec * 1000);
  }

  // URL更新タイマーと再接続タイマーを解除する。
  private clearTimers(runtime: JobRuntime) {
    if (runtime.refreshTimer) clearInterval(runtime.refreshTimer);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.refreshTimer = undefined;
    runtime.reconnectTimer = undefined;
  }

  // タイマー起点でURL切替または再読込処理を実行する。
  private async runRefreshTick(runtime: JobRuntime, jobId: bigint) {
    const job = await this.loadJob(jobId);
    if (!job || runtime.stopping) return;
    if (job.inputSourceType !== 'browser') return;
    const switchSec = Math.max(job.refreshIntervalSec ?? MIN_REFRESH_SEC, MIN_REFRESH_SEC);
    const urls = this.resolveUrlsOrdered(job);
    if (!urls.length) return;
    if (runtime.mode === 'real' && runtime.urlTabs.size === 0) {
      await this.ensureBrowserTabs(runtime, job);
      await this.restoreCookies(runtime);
      await this.refreshAllTabs(runtime, job, true);
      await this.activateCurrentUrl(runtime, runtime.currentUrlId ?? urls[0]?.id);
    }
    const positiveUrlSecs = urls
      .map((u) => u.refreshIntervalSec)
      .filter((sec) => sec > 0)
      .map((sec) => Math.max(sec, MIN_REFRESH_SEC));
    const minUrlSec = Math.max(
      MIN_REFRESH_SEC,
      Math.min(...(positiveUrlSecs.length ? positiveUrlSecs : [switchSec]))
    );
    const tickSec = Math.max(MIN_REFRESH_SEC, Math.min(switchSec, minUrlSec));
    if (runtime.currentRefreshIntervalSec !== tickSec) {
      this.setRefreshTimer(runtime, jobId, tickSec);
    }

    const now = Date.now();
    for (const entry of urls) {
      if (entry.refreshIntervalSec === 0) continue;
      const reloadSec = Math.max(entry.refreshIntervalSec, MIN_REFRESH_SEC);
      const lastReloadAt = runtime.urlLastReloadAt.get(entry.id) ?? 0;
      if (now - lastReloadAt < reloadSec * 1000) continue;
      await this.log(jobId, 'info', 'scheduler', `url reload (${reloadSec}s) -> ${entry.url}`);
      if (runtime.mode === 'real') {
        const ok = await this.reloadUrlTab(runtime, entry.id);
        if (!ok) {
          await this.log(jobId, 'warn', 'scheduler', `url reload failed: ${entry.url}`);
          continue;
        }
      }
      runtime.urlLastReloadAt.set(entry.id, now);
    }

    const lastSwitchAt = runtime.lastSwitchAt ?? 0;
    if (now - lastSwitchAt < switchSec * 1000) return;
    if (urls.length > 1) {
      const currentIndex = urls.findIndex((u) => u.id === runtime.currentUrlId);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % urls.length : 0;
      const next = urls[nextIndex];
      await this.log(
        jobId,
        'info',
        'scheduler',
        `url rotate -> ${next.url} (switch=${switchSec}s, url_refresh=${next.refreshIntervalSec === 0 ? 'disabled' : `${Math.max(next.refreshIntervalSec, MIN_REFRESH_SEC)}s`})`
      );
      runtime.currentUrl = next.url;
      runtime.currentUrlId = next.id;
      runtime.lastSwitchAt = now;
      if (runtime.mode === 'real') {
        const switched = await this.activateCurrentUrl(runtime, next.id);
        if (!switched) {
          await this.log(jobId, 'error', 'scheduler', `url rotate failed after retries: ${next.url}`);
        }
      }
    } else {
      runtime.lastSwitchAt = now;
    }
  }

  // URL切替をリトライ付きで実行する。
  private async switchUrlWithRetry(runtime: JobRuntime, url: string): Promise<boolean> {
    for (let i = 0; i < 3; i += 1) {
      try {
        if (!runtime.cdp) {
          await this.restartChromium(runtime, runtime.currentUrl ?? 'about:blank');
        }
        await this.navigateWithTimeout(runtime, url, URL_SWITCH_TIMEOUT_MS);
        return true;
      } catch (err) {
        await this.log(runtime.jobId, 'warn', 'scheduler', `url rotate retry ${i + 1}/3 failed: ${String(err)}`);
        if (i < 2) {
          await this.restartChromium(runtime, url).catch(() => undefined);
        }
      }
    }
    return false;
  }

  // 現在表示中ページをCDP経由で再読込する。
  private async reloadPage(runtime: JobRuntime): Promise<boolean> {
    const proc = runtime.processes.chromium;
    if (!proc || proc.killed || proc.exitCode !== null || !runtime.cdp) {
      return false;
    }
    try {
      await runtime.cdp.reload();
      await this.applyBrowserLayout(runtime);
      return true;
    } catch {
      return false;
    }
  }

  // Chromiumを再起動して指定URLへ復帰させる。
  private async restartChromium(runtime: JobRuntime, url: string) {
    if (runtime.mode !== 'real') return;
    const job = await this.loadJob(runtime.jobId);
    if (!job || job.inputSourceType !== 'browser') return;

    await this.persistCookies(runtime).catch(() => undefined);
    const clients = new Set<CdpClient>([...runtime.urlTabs.values()].map((x) => x.cdp));
    if (runtime.cdp) clients.add(runtime.cdp);
    for (const cdp of clients) {
      await cdp.close().catch(() => undefined);
    }
    runtime.urlTabs.clear();
    runtime.cdp = undefined;

    const proc = runtime.processes.chromium;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    await this.sleep(200);

    runtime.processes.chromium = this.spawnProcess(
      runtime,
      'chromium',
      'chromium',
      [
        `--remote-debugging-port=${runtime.debugPort}`,
        `--user-data-dir=/tmp/noc-chrome-${runtime.jobId}`,
        '--kiosk',
        `--window-size=${runtime.captureWidth},${runtime.captureHeight}`,
        '--window-position=0,0',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        'about:blank'
      ],
      { DISPLAY: `:${runtime.displayNum}` }
    );
    await this.waitProcessHealthy(runtime.processes.chromium, START_TIMEOUT_CHROMIUM_MS, 'chromium');
    await this.ensureBrowserTabs(runtime, job);
    await this.restoreCookies(runtime);
    await this.refreshAllTabs(runtime, job, true);
    await this.activateCurrentUrl(runtime, runtime.currentUrlId);
    runtime.currentUrl = url || runtime.currentUrl;
  }

  // URLごとのタブを生成してCDPセッションを確立する。
  private async ensureBrowserTabs(runtime: JobRuntime, job: JobWithUrls) {
    runtime.urlTabs.clear();
    const urls = this.resolveUrlsOrdered(job);
    for (const entry of urls) {
      const target = await CdpClient.createTarget(runtime.debugPort, entry.url);
      if (!target.id || !target.webSocketDebuggerUrl) {
        throw new Error(`target creation failed: ${entry.url}`);
      }
      const cdp = await CdpClient.connectByWsUrl(target.webSocketDebuggerUrl);
      const tab: UrlTab = { targetId: target.id, cdp, url: entry.url };
      runtime.urlTabs.set(entry.id, tab);
      runtime.urlLastReloadAt.set(entry.id, Date.now());
    }
  }

  // 全タブに対して初期ロードまたは再ロードを行う。
  private async refreshAllTabs(runtime: JobRuntime, job: JobWithUrls, forceNavigate = false) {
    const urls = this.resolveUrlsOrdered(job);
    for (const entry of urls) {
      const tab = runtime.urlTabs.get(entry.id);
      if (!tab) continue;
      if (forceNavigate) {
        await this.navigateTabWithTimeout(tab.cdp, entry.url, URL_SWITCH_TIMEOUT_MS);
      } else {
        await tab.cdp.reload();
      }
      await this.applyBrowserLayout(runtime, tab.cdp);
      runtime.urlLastReloadAt.set(entry.id, Date.now());
    }
  }

  // 指定URLタブを前面表示に切り替える。
  private async activateCurrentUrl(runtime: JobRuntime, urlId?: bigint): Promise<boolean> {
    if (!urlId) return false;
    const tab = runtime.urlTabs.get(urlId);
    if (!tab) return false;
    for (let i = 0; i < 3; i += 1) {
      try {
        await CdpClient.activateTarget(runtime.debugPort, tab.targetId);
        await this.applyBrowserLayout(runtime, tab.cdp);
        runtime.cdp = tab.cdp;
        return true;
      } catch (err) {
        await this.log(runtime.jobId, 'warn', 'scheduler', `activate retry ${i + 1}/3 failed: ${String(err)}`);
        await this.sleep(300);
      }
    }
    return false;
  }

  // 指定URLタブを再読込する。
  private async reloadUrlTab(runtime: JobRuntime, urlId: bigint): Promise<boolean> {
    const tab = runtime.urlTabs.get(urlId);
    if (!tab) return false;
    for (let i = 0; i < 2; i += 1) {
      try {
        await tab.cdp.reload();
        await this.applyBrowserLayout(runtime, tab.cdp);
        return true;
      } catch {
        await this.sleep(200);
      }
    }
    return false;
  }

  // 優先度順で先頭のURLエントリを取得する。
  private resolvePrimaryUrl(job: JobWithUrls): JobUrl | undefined {
    if (!job.urls.length) return undefined;
    const sorted = this.resolveUrlsOrdered(job);
    return sorted[0];
  }

  // URLリストを優先度・ID順で安定ソートする。
  private resolveUrlsOrdered(job: JobWithUrls): JobUrl[] {
    return [...job.urls].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  // プロトコル別にFFmpeg出力先URLを組み立てる。
  private buildOutputTarget(job: Job): string {
    const base = job.outputUrl.trim();
    const streamKey = decryptSecret(job.streamKeyEnc);
    if (job.protocol === 'rtmp') {
      return streamKey ? `${base}/${streamKey}` : base;
    }

    const params: string[] = [];
    if (job.srtMode) params.push(`mode=${encodeURIComponent(job.srtMode)}`);
    if (job.srtLatencyMs) params.push(`latency=${job.srtLatencyMs}`);
    if (streamKey && !/[?&]streamid=/i.test(base)) params.push(`streamid=${encodeURIComponent(streamKey)}`);

    if (!params.length) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}`;
  }

  // オーバーレイ有無を含む映像フィルター文字列を生成する。
  private buildVideoFilter(job: Job): string {
    const filters: string[] = ['format=yuv420p'];
    if (job.overlayEnabled) {
      filters.push(this.buildDrawTextFilter(job));
    }
    return filters.join(',');
  }

  // 時刻とメッセージのdrawtextフィルターを生成する。
  private buildDrawTextFilter(job: Job): string {
    const message = (job.overlayMessage ?? '').trim();
    const escapedMessage = message ? ` ${this.escapeDrawTextMessage(message)}` : '';
    const text = `%Y/%m/%d %H\\:%M\\:%S${escapedMessage}`;
    const size = Math.max(8, Math.min(job.overlayFontSizePx || 24, 200));

    const posMap: Record<string, { x: string; y: string }> = {
      top_left: { x: '20', y: '20' },
      top_right: { x: 'w-tw-20', y: '20' },
      bottom_left: { x: '20', y: 'h-th-20' },
      bottom_right: { x: 'w-tw-20', y: 'h-th-20' }
    };
    const pos = posMap[job.overlayPosition] ?? posMap.top_left;

    return `drawtext=text='${text}':expansion=strftime:x=${pos.x}:y=${pos.y}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`;
  }

  // drawtextで解釈される記号をエスケープする。
  private escapeDrawTextMessage(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll(':', '\\:')
      .replaceAll("'", "\\'")
      .replaceAll('%', '%%')
      .replaceAll(',', '\\,');
  }

  // 子プロセスを起動し、ログ収集と異常終了監視を紐づける。
  private spawnProcess(
    runtime: JobRuntime,
    source: keyof WorkerProc,
    command: string,
    args: string[],
    env: Record<string, string>
  ) {
    const proc = spawn(command, args, {
      env: {
        ...process.env,
        ...env
      },
      stdio: 'pipe'
    });

    proc.stdout.on('data', (chunk) => {
      void this.log(runtime.jobId, 'info', source, String(chunk).trim());
    });

    proc.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      const bitrate = line.match(/bitrate=\s*([0-9.]+)kbits\/s/i);
      if (bitrate) {
        runtime.lastBitrateKbps = Number(bitrate[1]);
      }
      void this.log(runtime.jobId, 'warn', source, line);
    });

    proc.on('exit', (code, signal) => {
      void this.log(runtime.jobId, 'warn', source, `exited code=${code} signal=${signal}`);
      const activeProc = runtime.processes[source];
      if (!runtime.stopping && activeProc === proc) {
        void this.handleFailure(runtime, `${source} exited unexpectedly`);
      }
    });

    return proc;
  }

  // ジョブごとの実行時コンテキストを取得または新規作成する。
  private async getOrCreateRuntime(jobId: bigint): Promise<JobRuntime> {
    const existing = this.runtimes.get(jobId);
    if (existing) return existing;

    const runtime: JobRuntime = {
      jobId,
      mode: workerMode,
      displayNum: 100 + Number(jobId % 1000n),
      captureWidth: 1920,
      captureHeight: 1080,
      vncPort: vncBasePort + Number(jobId % BigInt(vncPortSpan)),
      debugPort: 9222 + Number(jobId % 1000n),
      processes: {},
      retries: 0,
      stopping: false,
      urlTabs: new Map<bigint, UrlTab>(),
      urlLastReloadAt: new Map<bigint, number>(),
      lock: Promise.resolve()
    };
    this.runtimes.set(jobId, runtime);
    return runtime;
  }

  // 実行時コンテキストが稼働中かどうかを判定する。
  private isRunning(runtime: JobRuntime): boolean {
    if (runtime.mode === 'mock') {
      return Boolean(runtime.refreshTimer);
    }
    const browserMode = (runtime.currentInputSourceType ?? 'browser') === 'browser';
    if (browserMode) {
      return Boolean(runtime.processes.xvfb && runtime.processes.chromium && runtime.processes.ffmpeg);
    }
    return Boolean(runtime.processes.ffmpeg);
  }

  // ジョブ定義とURL一覧をDBから取得する。
  private async loadJob(jobId: bigint): Promise<JobWithUrls | null> {
    return prisma.job.findUnique({
      where: { id: jobId },
      include: {
        urls: {
          orderBy: [{ priority: 'asc' }, { id: 'asc' }]
        }
      }
    });
  }

  // ジョブ状態をDBへ反映する。
  private async updateStatus(jobId: bigint, status: JobStatus) {
    await prisma.job.update({ where: { id: jobId }, data: { status } });
  }

  // ジョブイベントログをDBへ記録する。
  private async log(jobId: bigint, level: string, source: string, message: string) {
    const text = message.trim();
    if (!text) return;

    await prisma.jobEvent.create({
      data: {
        jobId,
        level,
        source,
        message: text.slice(0, 4000)
      }
    });
  }

  // 同一ジョブの開始/停止操作を直列化する排他制御を行う。
  private async withLock(runtime: JobRuntime, fn: () => Promise<void>) {
    const previous = runtime.lock;
    let release: () => void = () => {};
    runtime.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      await fn();
    } finally {
      release();
    }
  }

  // 指定ミリ秒待機する。
  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // プロセスが一定時間生存していることを確認する。
  private async waitProcessHealthy(
    proc: ChildProcessWithoutNullStreams | undefined,
    timeoutMs: number,
    label: string
  ) {
    if (!proc) throw new Error(`${label} process missing`);
    const stableMs = 800;
    const start = Date.now();
    let aliveSince = 0;
    while (Date.now() - start < timeoutMs) {
      if (proc.exitCode !== null || proc.killed) {
        throw new Error(`${label} exited during startup`);
      }
      if (!aliveSince) aliveSince = Date.now();
      if (Date.now() - aliveSince >= stableMs) {
        return;
      }
      await this.sleep(100);
    }
    throw new Error(`${label} startup timeout`);
  }

  // CDP接続可能になるまでリトライして待機する。
  private async waitForCdp(debugPort: number, timeoutMs: number): Promise<CdpClient> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        return await CdpClient.connect(debugPort);
      } catch {
        await this.sleep(300);
      }
    }
    throw new Error('cdp connection timeout');
  }

  // キャプチャ向けビューポートとスタイルをブラウザへ適用する。
  private async applyBrowserLayout(runtime: JobRuntime, cdp = runtime.cdp) {
    if (!cdp) return;
    await cdp.setViewport(runtime.captureWidth, runtime.captureHeight).catch(() => undefined);
    await cdp.applyCaptureStyle().catch(() => undefined);
  }

  // 保存済みCookieをブラウザへ復元する。
  private async restoreCookies(runtime: JobRuntime) {
    const state = await prisma.jobBrowserState.findUnique({ where: { jobId: runtime.jobId } });
    if (!state?.cookiesJson) return;
    const cookies = JSON.parse(state.cookiesJson) as unknown[];
    for (const tab of runtime.urlTabs.values()) {
      await tab.cdp.setCookies(cookies).catch(() => undefined);
    }
    if (runtime.cdp && runtime.urlTabs.size === 0) {
      await runtime.cdp.setCookies(cookies).catch(() => undefined);
    }
  }

  // 現在のCookieをDBへ永続化する。
  private async persistCookies(runtime: JobRuntime) {
    const active = runtime.cdp ?? runtime.urlTabs.values().next().value?.cdp;
    if (!active) return;
    const cookies = await active.getCookies();
    await prisma.jobBrowserState.upsert({
      where: { jobId: runtime.jobId },
      update: { cookiesJson: JSON.stringify(cookies) },
      create: { jobId: runtime.jobId, cookiesJson: JSON.stringify(cookies) }
    });
  }

  // FFmpegのCPU/RSS/ビットレート情報を定期記録する。
  private async collectRuntimeMetrics(runtime: JobRuntime) {
    if (!runtime.processes.ffmpeg?.pid) return;
    const now = Date.now();
    if (runtime.lastMetricAt && now - runtime.lastMetricAt < 30_000) return;
    runtime.lastMetricAt = now;

    try {
      const { stdout } = await execFileAsync('ps', [
        '-p',
        String(runtime.processes.ffmpeg.pid),
        '-o',
        '%cpu=,rss='
      ]);
      const [cpuRaw, rssRaw] = stdout.trim().split(/\s+/);
      const cpu = Number(cpuRaw);
      const rssKb = Number(rssRaw);
      await this.log(
        runtime.jobId,
        'info',
        'metrics',
        `ffmpeg cpu=${Number.isFinite(cpu) ? cpu.toFixed(1) : 'n/a'}% rss_kb=${Number.isFinite(rssKb) ? rssKb : 'n/a'} bitrate_kbps=${runtime.lastBitrateKbps ?? 'n/a'}`
      );
    } catch {
      // ignore metric failures
    }
  }

  // タイムアウト付きでブラウザ遷移を実行する。
  private async navigateWithTimeout(runtime: JobRuntime, url: string, timeoutMs: number) {
    if (!runtime.cdp) throw new Error('cdp unavailable');
    await this.navigateTabWithTimeout(runtime.cdp, url, timeoutMs);
  }

  // タイムアウト付きで指定タブを遷移する。
  private async navigateTabWithTimeout(cdp: CdpClient, url: string, timeoutMs: number) {
    await Promise.race([
      cdp.navigate(url),
      (async () => {
        await this.sleep(timeoutMs);
        throw new Error(`navigate timeout (${timeoutMs}ms)`);
      })()
    ]);
  }
}

export const jobWorkerService = new JobWorkerService();
