import { createApp } from "./api/app.js";
import { loadConfig } from "./config/env.js";

const config = loadConfig(process.env);
const app = createApp({ config });

app.listen(config.PORT, () => {
  console.log(`La API RAG de Connectia escucha en el puerto ${config.PORT}`);
});
