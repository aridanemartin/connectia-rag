import { createApp } from "./api/app.js";
import { loadConfig } from "./config/env.js";

const config = loadConfig(process.env);
const app = createApp({ config });

app.listen(config.PORT, () => {
  console.log(`Connectia RAG API listening on port ${config.PORT}`);
});
