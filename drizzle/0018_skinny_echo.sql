CREATE INDEX `idx_ai_gateway_costs_day_start` ON `ai_gateway_costs` (`day_start`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_reg_at` ON `ai_usage_registrations` (`at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_reg_worker` ON `ai_usage_registrations` (`worker`);--> statement-breakpoint
CREATE INDEX `idx_billing_events_ts` ON `billing_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_daily_cost_day_start` ON `daily_cost` (`day_start`);--> statement-breakpoint
CREATE INDEX `idx_usage_snapshots_ts` ON `usage_snapshots` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_usage_snapshots_service_ts` ON `usage_snapshots` (`service`,`timestamp`);