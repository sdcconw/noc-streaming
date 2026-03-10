// ジョブの作成・更新・起動停止・一覧取得を扱うジョブ管理APIルーター。
import { JobStatus, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { jobWorkerService } from '../lib/job-worker.js';
import { prisma } from '../lib/prisma.js';
import { encryptSecret } from '../lib/secrets.js';

const jobsRouter = Router();
jobsRouter.use('/api/jobs', requireAuth);
const roleViewerOrAbove = requireRole(['viewer', 'operator', 'admin']);
const roleOperatorOrAbove = requireRole(['operator', 'admin']);
const roleAdminOnly = requireRole(['admin']);
const vncEnabled = (process.env.WORKER_VNC_ENABLED ?? 'true').toLowerCase() === 'true';
const vncPublicHost = (process.env.VNC_PUBLIC_HOST ?? 'localhost').trim() || 'localhost';
const vncBasePort = Number(process.env.VNC_BASE_PORT ?? 15900);
const vncPortSpan = Math.max(1, Number(process.env.VNC_PORT_SPAN ?? 50));
const novncEnabled = (process.env.NOVNC_ENABLED ?? 'true').toLowerCase() === 'true';
const novncPublicBaseUrl =
  (process.env.NOVNC_PUBLIC_BASE_URL ?? 'http://localhost:6080').trim().replace(/\/+$/, '') ||
  'http://localhost:6080';

const jobUrlSchema = z.object({
  url: z.string().url(),
  priority: z.number().int().min(1),
  refresh_interval_sec: z.number().int().min(0).default(10)
});

const createJobSchema = z.object({
  name: z.string().min(1).max(128),
  resolution_width: z.number().int().positive(),
  resolution_height: z.number().int().positive(),
  fps: z.number().int().positive(),
  bitrate_kbps: z.number().int().positive(),
  codec: z.string().min(1),
  preset: z.string().min(1),
  protocol: z.enum(['rtmp', 'srt']),
  output_url: z.string().min(1),
  stream_key: z.string().default(''),
  input_source_type: z.enum(['browser', 'test_pattern']).default('browser'),
  test_pattern_type: z.string().min(1).max(32).optional().nullable(),
  test_pattern_params: z.string().max(1024).optional().nullable(),
  overlay_enabled: z.boolean().default(false),
  overlay_message: z.string().max(255).default(''),
  overlay_position: z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right']).default('top_left'),
  overlay_font_size_px: z.number().int().min(8).max(200).default(24),
  srt_latency_ms: z.number().int().positive().optional().nullable(),
  srt_mode: z.string().optional().nullable(),
  refresh_interval_sec: z.number().int().min(10),
  max_retries: z.number().int().min(0),
  retry_interval_sec: z.number().int().min(1),
  urls: z.array(jobUrlSchema).min(1)
});

const updateJobSchema = createJobSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'request body must include at least one updatable field'
);

// 互換用の固定時刻（00:00:00 UTC）を返す。
function fixedScheduleTime(): Date {
  const d = new Date(0);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// URLパラメータのジョブIDをバリデーションして`bigint`化する。
function parseJobId(idParam: string): bigint {
  if (!/^\d+$/.test(idParam)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'id must be a positive integer'
      }
    ]);
  }

  return BigInt(idParam);
}

// ジョブIDからVNC公開ポートを算出する。
function calcVncPort(jobId: bigint): number {
  return vncBasePort + Number(jobId % BigInt(vncPortSpan));
}

// noVNC接続用URLを生成する。
function buildNoVncUrl(jobId: bigint): string {
  const token = `job-${Number(jobId)}`;
  const path = encodeURIComponent(`websockify?token=${token}`);
  return `${novncPublicBaseUrl}/vnc.html?autoconnect=1&resize=scale&path=${path}`;
}

// DBレコード形式のジョブ情報をAPIレスポンス形式へ変換する。
function mapJob(job: {
  id: bigint;
  name: string;
  status: JobStatus;
  resolutionWidth: number;
  resolutionHeight: number;
  fps: number;
  bitrateKbps: number;
  codec: string;
  preset: string;
  protocol: 'rtmp' | 'srt';
  outputUrl: string;
  inputSourceType: 'browser' | 'test_pattern';
  testPatternType: string | null;
  testPatternParams: string | null;
  overlayEnabled: boolean;
  overlayMessage: string;
  overlayPosition: string;
  overlayFontSizePx: number;
  srtLatencyMs: number | null;
  srtMode: string | null;
  refreshIntervalSec: number;
  maxRetries: number;
  retryIntervalSec: number;
  urls: Array<{ url: string; priority: number; refreshIntervalSec: number }>;
}) {
  return {
    id: Number(job.id),
    name: job.name,
    status: job.status,
    resolution_width: job.resolutionWidth,
    resolution_height: job.resolutionHeight,
    fps: job.fps,
    bitrate_kbps: job.bitrateKbps,
    codec: job.codec,
    preset: job.preset,
    protocol: job.protocol,
    output_url: job.outputUrl,
    input_source_type: job.inputSourceType,
    test_pattern_type: job.testPatternType,
    test_pattern_params: job.testPatternParams,
    overlay_enabled: job.overlayEnabled,
    overlay_message: job.overlayMessage,
    overlay_position: job.overlayPosition,
    overlay_font_size_px: job.overlayFontSizePx,
    vnc_enabled: vncEnabled && job.inputSourceType === 'browser',
    vnc_port: vncEnabled && job.inputSourceType === 'browser' ? calcVncPort(job.id) : null,
    vnc_host: vncEnabled && job.inputSourceType === 'browser' ? vncPublicHost : null,
    vnc_url:
      vncEnabled && job.inputSourceType === 'browser'
        ? `vnc://${vncPublicHost}:${calcVncPort(job.id)}`
        : null,
    novnc_enabled: vncEnabled && novncEnabled && job.inputSourceType === 'browser',
    novnc_url:
      vncEnabled && novncEnabled && job.inputSourceType === 'browser' ? buildNoVncUrl(job.id) : null,
    srt_latency_ms: job.srtLatencyMs,
    srt_mode: job.srtMode,
    refresh_interval_sec: job.refreshIntervalSec,
    max_retries: job.maxRetries,
    retry_interval_sec: job.retryIntervalSec,
    urls: job.urls.map((u) => ({
      url: u.url,
      priority: u.priority,
      refresh_interval_sec: u.refreshIntervalSec
    }))
  };
}

// Prismaのレコード未検出エラーかどうかを判定する。
function isPrismaNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

// Prismaの一意制約違反エラーかどうかを判定する。
function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// ワーカー層から返るジョブ未検出エラーかどうかを判定する。
function isJobNotFound(err: unknown): boolean {
  return err instanceof Error && err.message === 'job not found';
}

jobsRouter.get('/api/jobs', roleViewerOrAbove, async (_req, res, next) => {
  try {
    const jobs = await prisma.job.findMany({
      include: {
        urls: {
          orderBy: [{ priority: 'asc' }, { id: 'asc' }]
        }
      },
      orderBy: { id: 'asc' }
    });

    res.json(jobs.map(mapJob));
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/api/jobs', roleAdminOnly, async (req, res, next) => {
  try {
    const body = createJobSchema.parse(req.body);

    const created = await prisma.job.create({
      data: {
        name: body.name,
        status: JobStatus.STOPPED,
        resolutionWidth: body.resolution_width,
        resolutionHeight: body.resolution_height,
        fps: body.fps,
        bitrateKbps: body.bitrate_kbps,
        codec: body.codec,
        preset: body.preset,
        protocol: body.protocol,
        outputUrl: body.output_url,
        streamKeyEnc: body.stream_key ? encryptSecret(body.stream_key) : '',
        inputSourceType: body.input_source_type,
        testPatternType: body.test_pattern_type || null,
        testPatternParams: body.test_pattern_params || null,
        overlayEnabled: body.overlay_enabled,
        overlayMessage: body.overlay_message,
        overlayPosition: body.overlay_position,
        overlayFontSizePx: body.overlay_font_size_px,
        srtLatencyMs: body.srt_latency_ms,
        srtMode: body.srt_mode,
        refreshIntervalSec: body.refresh_interval_sec,
        maxRetries: body.max_retries,
        retryIntervalSec: body.retry_interval_sec,
        urls: {
          create: body.urls.map((u) => ({
            scheduleTime: fixedScheduleTime(),
            url: u.url,
            priority: u.priority,
            refreshIntervalSec: u.refresh_interval_sec
          }))
        }
      },
      include: { urls: true }
    });

    await writeAudit(req, res, 'job.create', 'job', String(created.id), {
      name: created.name,
      protocol: created.protocol
    });

    res.status(201).json(mapJob(created));
  } catch (err) {
    if (isPrismaUniqueViolation(err)) {
      res.status(409).json({ message: 'job name already exists' });
      return;
    }

    next(err);
  }
});

jobsRouter.get('/api/jobs/:id/status', roleViewerOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    const job = await prisma.job.findUnique({
      where: { id },
      select: { id: true, status: true }
    });

    if (!job) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    res.json({ id: Number(job.id), status: job.status });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/api/jobs/:id/start', roleOperatorOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    await jobWorkerService.start(id);
    await writeAudit(req, res, 'job.start', 'job', String(id));
    res.status(202).json({ message: 'start accepted' });
  } catch (err) {
    if (isPrismaNotFound(err) || isJobNotFound(err)) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    next(err);
  }
});

jobsRouter.post('/api/jobs/:id/stop', roleOperatorOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    await jobWorkerService.stop(id);
    await writeAudit(req, res, 'job.stop', 'job', String(id));
    res.status(202).json({ message: 'stop accepted' });
  } catch (err) {
    if (isPrismaNotFound(err) || isJobNotFound(err)) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    next(err);
  }
});

jobsRouter.post('/api/jobs/:id/restart', roleOperatorOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    await jobWorkerService.restart(id);
    await writeAudit(req, res, 'job.restart', 'job', String(id));
    res.status(202).json({ message: 'restart accepted' });
  } catch (err) {
    if (isPrismaNotFound(err) || isJobNotFound(err)) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    next(err);
  }
});

jobsRouter.get('/api/jobs/:id/logs', roleViewerOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    const logs = await jobWorkerService.getLogs(id, 200);
    res.json({
      items: logs.map((log) => ({
        id: Number(log.id),
        level: log.level,
        source: log.source,
        message: log.message,
        created_at: log.createdAt.toISOString()
      }))
    });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/api/jobs/:id', roleViewerOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        urls: {
          orderBy: [{ priority: 'asc' }, { id: 'asc' }]
        }
      }
    });
    if (!job) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    res.json(mapJob(job));
  } catch (err) {
    next(err);
  }
});

jobsRouter.put('/api/jobs/:id', roleOperatorOrAbove, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    const body = updateJobSchema.parse(req.body);

    const hasStreamKeyField = Object.prototype.hasOwnProperty.call(body, 'stream_key');

    await prisma.job.update({
      where: { id },
      data: {
        name: body.name,
        resolutionWidth: body.resolution_width,
        resolutionHeight: body.resolution_height,
        fps: body.fps,
        bitrateKbps: body.bitrate_kbps,
        codec: body.codec,
        preset: body.preset,
        protocol: body.protocol,
        outputUrl: body.output_url,
        streamKeyEnc: hasStreamKeyField ? (body.stream_key ? encryptSecret(body.stream_key) : '') : undefined,
        inputSourceType: body.input_source_type,
        testPatternType: body.test_pattern_type === undefined ? undefined : body.test_pattern_type || null,
        testPatternParams:
          body.test_pattern_params === undefined ? undefined : body.test_pattern_params || null,
        overlayEnabled: body.overlay_enabled,
        overlayMessage: body.overlay_message,
        overlayPosition: body.overlay_position,
        overlayFontSizePx: body.overlay_font_size_px,
        srtLatencyMs: body.srt_latency_ms,
        srtMode: body.srt_mode,
        refreshIntervalSec: body.refresh_interval_sec,
        maxRetries: body.max_retries,
        retryIntervalSec: body.retry_interval_sec
      }
    });

    if (body.urls) {
      await prisma.jobUrl.deleteMany({ where: { jobId: id } });
      await prisma.jobUrl.createMany({
        data: body.urls.map((u) => ({
          jobId: id,
          scheduleTime: fixedScheduleTime(),
          url: u.url,
          priority: u.priority,
          refreshIntervalSec: u.refresh_interval_sec
        }))
      });
    }

    const refreshed = await prisma.job.findUnique({
      where: { id },
      include: {
        urls: {
          orderBy: [{ priority: 'asc' }, { id: 'asc' }]
        }
      }
    });
    if (!refreshed) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    await writeAudit(req, res, 'job.update', 'job', String(id), {
      fields: Object.keys(body)
    });

    res.json(mapJob(refreshed));
  } catch (err) {
    if (isPrismaNotFound(err)) {
      res.status(404).json({ message: 'job not found' });
      return;
    }
    if (isPrismaUniqueViolation(err)) {
      res.status(409).json({ message: 'job name already exists' });
      return;
    }

    next(err);
  }
});

jobsRouter.delete('/api/jobs/:id', roleAdminOnly, async (req, res, next) => {
  try {
    const id = parseJobId(req.params.id);
    await prisma.job.delete({ where: { id } });
    await writeAudit(req, res, 'job.delete', 'job', String(id));
    res.status(204).send();
  } catch (err) {
    if (isPrismaNotFound(err)) {
      res.status(404).json({ message: 'job not found' });
      return;
    }

    next(err);
  }
});

export { jobsRouter };
