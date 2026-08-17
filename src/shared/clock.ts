import type { Clock } from "./shared.types.js";

export const systemClock: Clock = {
  now: () => new Date(),
};

export type { Clock }; // Re-exported for backward compatibility.
