// Stand-in for the eventual `hokago-cli` (— "password reset = admin
// action or CLI"). Bootstraps the first admin account directly: invite
// creation requires an admin and registration requires an invite, so
// something has to break that cycle once, out of band. The web wizard
// (GET/POST /setup/*) is the in-band version for fresh installs — this
// script remains for cases the wizard can't reach (API not yet up, etc.).
//
// Usage: pnpm --filter @hokago/api exec tsx scripts/bootstrap-admin.ts <username> <password>
import { PrismaClient } from "@hokago/db";
import { hashPassword } from "../src/auth.js";

const db = new PrismaClient();

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error("usage: bootstrap-admin.ts <username> <password>");
    process.exit(1);
  }

  const existing = await db.account.findUnique({ where: { username } });
  if (existing) {
    console.error(`account "${username}" already exists (id: ${existing.id})`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const account = await db.account.create({ data: { username, passwordHash, isAdmin: true } });
  // Same rule as registration: every account gets a primary profile named
  // after the username, or prefs/avatar features silently no-op.
  await db.profile.create({ data: { accountId: account.id, name: username } });
  // Stamp setup complete so the first-run wizard never reappears.
  await db.serverSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", setupCompletedAt: new Date() },
    update: { setupCompletedAt: new Date() },
  });
  console.log(`created admin account "${username}" (id: ${account.id})`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
