// アプリ全体の初期化、ミドルウェア設定、ルーティングを定義するエントリーポイント。
import express from 'express';
import fs from 'node:fs';
import helmet from 'helmet';
import path from 'node:path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { ZodError } from 'zod';

import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { bootstrapFromEnv } from './lib/bootstrap.js';
import { healthRouter } from './routes/health.js';
import { jobWorkerService } from './lib/job-worker.js';
import { jobsRouter } from './routes/jobs.js';

const app = express();
const CSRF_COOKIE = 'noc_csrf';
const OFFLINE_MODE = (process.env.OFFLINE ?? 'false').toLowerCase() === 'true';
const HSTS_ENABLED = (process.env.HSTS_ENABLED ?? 'true').toLowerCase() === 'true';
const CSP_UPGRADE_INSECURE_REQUESTS =
  (process.env.CSP_UPGRADE_INSECURE_REQUESTS ?? 'false').toLowerCase() === 'true';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openapiPath = path.resolve(process.cwd(), 'openapi/openapi.yaml');
const openapiDoc = YAML.parse(fs.readFileSync(openapiPath, 'utf8'));

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: CSP_UPGRADE_INSECURE_REQUESTS ? [] : null
      }
    },
    hsts: HSTS_ENABLED
      ? {
          maxAge: Number(process.env.HSTS_MAX_AGE ?? 31536000),
          includeSubDomains: (process.env.HSTS_INCLUDE_SUBDOMAINS ?? 'true').toLowerCase() === 'true'
        }
      : false
  })
);

// Cookieヘッダーから指定キーの値を取得する。
function parseCookieValue(rawCookie: string | undefined, key: string): string | null {
  if (!rawCookie) return null;
  for (const part of rawCookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === key) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/auth/login') return next();

  const authz = req.header('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) return next();

  const csrfCookie = parseCookieValue(req.headers.cookie, CSRF_COOKIE);
  const csrfHeader = req.header('x-csrf-token');
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    res.status(403).json({ message: 'csrf token mismatch' });
    return;
  }
  next();
});

const publicDir = path.resolve(process.cwd(), 'src/public');
app.get('/ui/runtime-config.js', (_req, res) => {
  res.type('application/javascript');
  res.setHeader('cache-control', 'no-store');
  res.send(`window.__NOC_RUNTIME__ = Object.freeze({ offline: ${OFFLINE_MODE} });`);
});
app.use('/ui', express.static(publicDir));
app.get('/', (_req, res) => {
  res.redirect('/ui/login.html');
});

app.use(healthRouter);
app.use(authRouter);
app.use(jobsRouter);
app.use(adminRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      message: 'validation error',
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
    return;
  }

  if (err instanceof Error) {
    res.status(500).json({ message: err.message });
    return;
  }

  res.status(500).json({ message: 'internal server error' });
});

// 起動時処理を実行してHTTPサーバーを開始する。
async function main() {
  await bootstrapFromEnv();

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    jobWorkerService.startMonitor();
    // eslint-disable-next-line no-console
    console.log(`noc-streaming API listening on :${port}`);
  });
}

void main();
