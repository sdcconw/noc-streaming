// 監査ログの記録処理を集約するユーティリティ。
import type { Request, Response } from 'express';

import { prisma } from './prisma.js';

// リクエスト起点の監査イベントを共通形式でDBへ記録する。
export async function writeAudit(
  req: Request,
  res: Response,
  action: string,
  targetType: string,
  targetId: string,
  detail?: unknown
) {
  const actor = (res.locals.authUser ?? {}) as { id?: bigint; username?: string };
  await prisma.auditLog.create({
    data: {
      actorUserId: actor.id,
      actorUsername: actor.username ?? 'system',
      action,
      targetType,
      targetId,
      detailJson: detail === undefined ? null : JSON.stringify(detail)
    }
  });
}
