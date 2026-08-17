CREATE TABLE `provider_cost` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`day_start` integer NOT NULL,
	`provider` text NOT NULL,
	`dimension` text DEFAULT '' NOT NULL,
	`metric` text DEFAULT 'spent' NOT NULL,
	`cost_usd` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_cost_day_start` ON `provider_cost` (`day_start`);--> statement-breakpoint
CREATE INDEX `idx_provider_cost_provider` ON `provider_cost` (`provider`);