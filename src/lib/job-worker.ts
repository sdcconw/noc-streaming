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
  currentRefreshIntervalSec?: number;
  debugPort: number;
  cdp?: CdpClient;
  lastBitrateKbps?: number;
  lastMetricAt?: number;
  currentInputSourceType?: 'browser' | 'test_pattern';
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

class JobWorkerService {
  private runtimes = new Map<bigint, JobRuntime>();

  public startMonitor() {
    setInterval(() => {
      void this.monitorHealth();
    }, monitorIntervalMs);
  }

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

  public async restart(jobId: bigint): Promise<void> {
    await this.stop(jobId);
    await this.start(jobId);
  }

  public async getLogs(jobId: bigint, limit = 200) {
    return prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit
    });
  }

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

  private async startPipeline(runtime: JobRuntime, job: JobWithUrls) {
    runtime.currentInputSourceType = job.inputSourceType;
    runtime.captureWidth = job.resolutionWidth;
    runtime.captureHeight = job.resolutionHeight;
    const current = this.resolvePrimaryUrl(job) ?? job.urls[0];
    runtime.currentUrl = current?.url ?? 'about:blank';
    runtime.currentUrlId = current?.id;
    runtime.currentRefreshIntervalSec = Math.max(current?.refreshIntervalSec ?? 60, 60);

    if (runtime.mode === 'mock') {
      await this.log(
        runtime.jobId,
        'info',
        'mock',
        `mock start: source=${runtime.currentInputSourceType} url=${runtime.currentUrl} (refresh=${runtime.currentRefreshIntervalSec}s)`
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
          runtime.currentUrl ?? 'about:blank'
        ],
        { DISPLAY: `:${runtime.displayNum}` }
      );
      await this.waitProcessHealthy(runtime.processes.chromium, START_TIMEOUT_CHROMIUM_MS, 'chromium');
      runtime.cdp = await this.waitForCdp(runtime.debugPort, START_TIMEOUT_CHROMIUM_MS);
      await this.applyBrowserLayout(runtime);
      await this.restoreCookies(runtime);
      await runtime.cdp.navigate(runtime.currentUrl ?? 'about:blank');
      await this.applyBrowserLayout(runtime);

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

  private async stopProcesses(runtime: JobRuntime, forceOnly: boolean) {
    this.clearTimers(runtime);

    const procs: ChildProcessWithoutNullStreams[] = [];
    if (runtime.processes.ffmpeg) procs.push(runtime.processes.ffmpeg);
    if (runtime.processes.chromium) procs.push(runtime.processes.chromium);
    if (runtime.processes.vnc) procs.push(runtime.processes.vnc);
    if (runtime.processes.xvfb) procs.push(runtime.processes.xvfb);

    await this.persistCookies(runtime).catch(() => undefined);
    if (runtime.cdp) {
      await runtime.cdp.close().catch(() => undefined);
      runtime.cdp = undefined;
    }
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

  private startTimers(runtime: JobRuntime, jobId: bigint, refreshIntervalSec: number) {
    this.clearTimers(runtime);
    this.setRefreshTimer(runtime, jobId, refreshIntervalSec);
  }

  private setRefreshTimer(runtime: JobRuntime, jobId: bigint, refreshIntervalSec: number) {
    if (runtime.refreshTimer) {
      clearInterval(runtime.refreshTimer);
    }

    const sec = Math.max(refreshIntervalSec, 60);
    runtime.currentRefreshIntervalSec = sec;
    runtime.refreshTimer = setInterval(() => {
      void this.runRefreshTick(runtime, jobId);
    }, sec * 1000);
  }

  private clearTimers(runtime: JobRuntime) {
    if (runtime.refreshTimer) clearInterval(runtime.refreshTimer);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.refreshTimer = undefined;
    runtime.reconnectTimer = undefined;
  }

  private async runRefreshTick(runtime: JobRuntime, jobId: bigint) {
    const job = await this.loadJob(jobId);
    if (!job || runtime.stopping) return;
    if (job.inputSourceType !== 'browser') return;
    const urls = this.resolveUrlsOrdered(job);
    if (!urls.length) return;

    if (urls.length > 1) {
      const currentIndex = urls.findIndex((u) => u.id === runtime.currentUrlId);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % urls.length : 0;
      const next = urls[nextIndex];
      const nextRefresh = Math.max(next.refreshIntervalSec, 60);

      await this.log(
        jobId,
        'info',
        'scheduler',
        `url rotate -> ${next.url} (refresh=${nextRefresh}s)`
      );

      runtime.currentUrl = next.url;
      runtime.currentUrlId = next.id;
      this.setRefreshTimer(runtime, jobId, nextRefresh);

      if (runtime.mode === 'real') {
        const switched = await this.switchUrlWithRetry(runtime, next.url);
        if (!switched) {
          await this.log(jobId, 'error', 'scheduler', `url rotate failed after retries: ${next.url}`);
        }
      }
      return;
    }

    await this.log(
      jobId,
      'info',
      'scheduler',
      `refresh tick (${runtime.currentRefreshIntervalSec ?? 60}s) url=${runtime.currentUrl ?? 'about:blank'}`
    );
    if (runtime.mode === 'real') {
      const ok = await this.reloadPage(runtime);
      if (!ok) {
        await this.log(jobId, 'warn', 'scheduler', 'refresh failed, retrying once');
        const retryOk = await this.reloadPage(runtime);
        if (!retryOk) {
          await this.log(jobId, 'warn', 'scheduler', 'refresh retry failed, restarting chromium');
          await this.restartChromium(runtime, runtime.currentUrl ?? 'about:blank');
        }
      }
    }
  }

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

  private async restartChromium(runtime: JobRuntime, url: string) {
    if (runtime.mode !== 'real') return;

    await this.persistCookies(runtime).catch(() => undefined);
    if (runtime.cdp) {
      await runtime.cdp.close().catch(() => undefined);
      runtime.cdp = undefined;
    }

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
        url
      ],
      { DISPLAY: `:${runtime.displayNum}` }
    );
    await this.waitProcessHealthy(runtime.processes.chromium, START_TIMEOUT_CHROMIUM_MS, 'chromium');
    runtime.cdp = await this.waitForCdp(runtime.debugPort, START_TIMEOUT_CHROMIUM_MS);
    await this.applyBrowserLayout(runtime);
    await this.restoreCookies(runtime);
    await runtime.cdp.navigate(url);
    await this.applyBrowserLayout(runtime);
  }

  private resolvePrimaryUrl(job: JobWithUrls): JobUrl | undefined {
    if (!job.urls.length) return undefined;
    const sorted = this.resolveUrlsOrdered(job);
    return sorted[0];
  }

  private resolveUrlsOrdered(job: JobWithUrls): JobUrl[] {
    return [...job.urls].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

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

  private buildVideoFilter(job: Job): string {
    const filters: string[] = ['format=yuv420p'];
    if (job.overlayEnabled) {
      filters.push(this.buildDrawTextFilter(job));
    }
    return filters.join(',');
  }

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

  private escapeDrawTextMessage(value: string): string {
    return value
      .replaceAll('\\', '\\\\')
      .replaceAll(':', '\\:')
      .replaceAll("'", "\\'")
      .replaceAll('%', '%%')
      .replaceAll(',', '\\,');
  }

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
      lock: Promise.resolve()
    };
    this.runtimes.set(jobId, runtime);
    return runtime;
  }

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

  private async updateStatus(jobId: bigint, status: JobStatus) {
    await prisma.job.update({ where: { id: jobId }, data: { status } });
  }

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

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  private async applyBrowserLayout(runtime: JobRuntime) {
    if (!runtime.cdp) return;
    await runtime.cdp.setViewport(runtime.captureWidth, runtime.captureHeight).catch(() => undefined);
    await runtime.cdp.applyCaptureStyle().catch(() => undefined);
  }

  private async restoreCookies(runtime: JobRuntime) {
    if (!runtime.cdp) return;
    const state = await prisma.jobBrowserState.findUnique({ where: { jobId: runtime.jobId } });
    if (!state?.cookiesJson) return;
    const cookies = JSON.parse(state.cookiesJson) as unknown[];
    await runtime.cdp.setCookies(cookies);
  }

  private async persistCookies(runtime: JobRuntime) {
    if (!runtime.cdp) return;
    const cookies = await runtime.cdp.getCookies();
    await prisma.jobBrowserState.upsert({
      where: { jobId: runtime.jobId },
      update: { cookiesJson: JSON.stringify(cookies) },
      create: { jobId: runtime.jobId, cookiesJson: JSON.stringify(cookies) }
    });
  }

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

  private async navigateWithTimeout(runtime: JobRuntime, url: string, timeoutMs: number) {
    if (!runtime.cdp) throw new Error('cdp unavailable');

    await Promise.race([
      runtime.cdp.navigate(url),
      (async () => {
        await this.sleep(timeoutMs);
        throw new Error(`navigate timeout (${timeoutMs}ms)`);
      })()
    ]);
  }
}

export const jobWorkerService = new JobWorkerService();
