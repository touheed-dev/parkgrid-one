/** npm run seed:kb  - idempotent: unchanged documents are skipped (SHA-256 of content). */
import { pool } from "../src/db/pool.js";
import { seedKb } from "../src/modules/kb/seed.js";

export { seedKb };

if (process.argv[1]?.endsWith("seed-kb.ts")) {
  seedKb()
    .then((r) => console.log("knowledge base seeded:", r))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
