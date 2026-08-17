CREATE TABLE `cf_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`resource_type` text DEFAULT '' NOT NULL,
	`resource_name` text DEFAULT '' NOT NULL,
	`cf_id` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cf_resources_product` ON `cf_resources` (`product`);--> statement-breakpoint
CREATE TABLE `resource_bindings` (
	`worker` text NOT NULL,
	`resource_id` text NOT NULL,
	`binding_name` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`worker`, `resource_id`),
	FOREIGN KEY (`resource_id`) REFERENCES `cf_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_resource_bindings_resource` ON `resource_bindings` (`resource_id`);--> statement-breakpoint
CREATE TABLE `resource_usage_snapshots` (
	`resource_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`window_hours` integer DEFAULT 1 NOT NULL,
	`usage_qty` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`resource_id`, `captured_at`),
	FOREIGN KEY (`resource_id`) REFERENCES `cf_resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_rus_captured` ON `resource_usage_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`cf_zone_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`billable` integer DEFAULT false NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_zones_billable` ON `zones` (`billable`);--> statement-breakpoint
ALTER TABLE `billable_usage` ADD `zone_fk` text;--> statement-breakpoint
--> backfill: existing zone-scoped rows carry the raw zone id in `zone_id`; seed the relation.
UPDATE `billable_usage` SET `zone_fk` = `zone_id` WHERE `zone_id` != '';