CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`service` text NOT NULL,
	`comparator` text DEFAULT 'gt' NOT NULL,
	`threshold` real,
	`window_hours` integer DEFAULT 1 NOT NULL,
	`severity` text DEFAULT 'moderate' NOT NULL,
	`action` text DEFAULT 'notify' NOT NULL,
	`action_target` text,
	`armed` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cooldown_minutes` integer DEFAULT 60 NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
