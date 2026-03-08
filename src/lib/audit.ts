import type { Request, Response } from 'express';

import { prisma } from './prisma.js';

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
