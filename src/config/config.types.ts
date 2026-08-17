import type { z } from "zod";
import type { envSchema } from "./env.js";

export type AppConfig = z.infer<typeof envSchema>;
