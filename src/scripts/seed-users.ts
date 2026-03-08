import bcrypt from 'bcryptjs';

import { prisma } from '../lib/prisma.js';

const users = [
  { username: 'admin', password: 'admin1234', role: 'admin' as const },
  { username: 'operator', password: 'operator1234', role: 'operator' as const },
  { username: 'viewer', password: 'viewer1234', role: 'viewer' as const }
];

async function main() {
  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 12);
    await prisma.user.upsert({
      where: { username: u.username },
      update: {
        passwordHash,
        authSource: 'local',
        role: u.role,
        isActive: true
      },
      create: {
        username: u.username,
        passwordHash,
        authSource: 'local',
        role: u.role,
        isActive: true
      }
    });
  }

  // eslint-disable-next-line no-console
  console.log('seeded users: admin, operator, viewer');
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
