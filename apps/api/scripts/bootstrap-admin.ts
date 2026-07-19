// Stand-in for the eventual `hokago-cli` (§7.1 — "password reset = admin
// action or CLI"). Bootstraps the first admin account directly: invite
// creation requires an admin and registration requires an invite, so
// something has to break that cycle once, out of band.
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
  console.log(`created admin account "${username}" (id: ${account.id})`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
