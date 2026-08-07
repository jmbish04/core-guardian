CREATE TABLE `billable_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`day_start` integer NOT NULL,
	`charge_period_start` text NOT NULL,
	`charge_period_end` text DEFAULT '' NOT NULL,
	`billing_period_start` text DEFAULT '' NOT NULL,
	`service_name` text NOT NULL,
	`service_family` text DEFAULT '' NOT NULL,
	`consumed_quantity` real DEFAULT 0 NOT NULL,
	`consumed_unit` text DEFAULT '' NOT NULL,
	`pricing_quantity` real DEFAULT 0 NOT NULL,
	`contracted_cost` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`zone_id` text DEFAULT '' NOT NULL,
	`zone_name` text DEFAULT '' NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_billable_usage_day_start` ON `billable_usage` (`day_start`);