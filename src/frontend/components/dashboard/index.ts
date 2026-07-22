/**
 * @fileoverview Barrel export for the Admin Dashboard feature.
 *
 * The Astro page imports only the top-level island from here; everything else
 * is an internal implementation detail of the feature folder.
 */

export { AdminDashboard } from "./AdminDashboard";
export { ActionItems } from "./ActionItems";
export { AllowancesPanel } from "./AllowancesPanel";
export { AlertsBoard } from "./AlertsBoard";
export { BindingDetail } from "./BindingDetail";
export { HealthConsole } from "./HealthConsole";
export { GuardianAuditLog } from "./GuardianAuditLog";
export { GuardianPanel } from "./GuardianPanel";
