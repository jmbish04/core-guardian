CREATE TABLE `ai_router_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`project` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`suggested_provider` text,
	`suggested_model` text,
	`rationale` text DEFAULT '' NOT NULL,
	`est_monthly_savings_usd` real DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'local' NOT NULL,
	`jules_session_id` text,
	`pr_url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_router_rec_project` ON `ai_router_recommendations` (`project`);--> statement-breakpoint
CREATE INDEX `idx_ai_router_rec_at` ON `ai_router_recommendations` (`at`);