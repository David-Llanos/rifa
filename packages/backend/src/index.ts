/**
 * Backend entry point for the modular monolith. Each service lives in its own folder under
 * `src/modules/<name>` with a pure domain core and I/O adapters. Modules are added by later tasks.
 */
export const MODULES = [
  "auth",
  "raffle",
  "inventory",
  "payment",
  "draw",
  "notification",
  "compliance",
  "fraud",
  "audit",
  "analytics",
  "backoffice",
  "scheduler",
] as const;

export type ModuleName = (typeof MODULES)[number];
