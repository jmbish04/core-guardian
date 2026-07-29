CREATE TABLE `daily_cost` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`day_start` integer NOT NULL,
	`service` text NOT NULL,
	`product` text NOT NULL,
	`dimension` text DEFAULT '' NOT NULL,
	`unit` text NOT NULL,
	`raw_usage` real DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`basis` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_usage_registrations` ADD `source_ip` text;