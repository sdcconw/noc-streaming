import bcrypt from 'bcryptjs';

import { prisma } from '../lib/prisma.js';

async function main() {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? 'admin1234';

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash,
      authSource: 'local',
      role: 'admin',
      isActive: true
    },
    create: {
      username,
      passwordHash,
      authSource: 'local',
      role: 'admin',
      isActive: true
    }
  });

  // eslint-disable-next-line no-console
  console.log(`admin user ready: ${username}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
