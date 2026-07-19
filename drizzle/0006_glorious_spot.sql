CREATE TABLE `usage_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`metric` text NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`window_hours` integer DEFAULT 1 NOT NULL,
	`timestamp` integer NOT NULL
);
