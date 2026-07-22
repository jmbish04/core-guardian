CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`resource` text NOT NULL,
	`worker` text,
	`severity` text NOT NULL,
	`cause` text NOT NULL,
	`recommendation` text NOT NULL,
	`projected_fraction` real,
	`est_cost_delta` real,
	`status` text DEFAULT 'active' NOT NULL,
	`snoozed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
