/** npm run kb:reembed - re-embed every chunk (needed after changing EMBEDDING_MODEL / EMBEDDING_DIM). */
import { pool } from "../src/db/pool.js";
import { reembedAll } from "../src/modules/kb/service.js";

reembedAll()
  .then((r) => console.log("re-embedded:", r))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
