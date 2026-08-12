CREATE INDEX `idx_ai_gateway_costs_captured_at` ON `ai_gateway_costs` (`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_model_pricing_scraped_at` ON `ai_model_pricing` (`scraped_at`);--> statement-breakpoint
CREATE INDEX `idx_billable_usage_captured_at` ON `billable_usage` (`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_daily_cost_captured_at` ON `daily_cost` (`captured_at`);