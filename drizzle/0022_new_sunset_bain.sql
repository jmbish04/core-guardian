CREATE TABLE `scan_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`worker_name` text,
	`cron_schedules` text,
	`risk_signals` text,
	`risk_score` integer DEFAULT 0 NOT NULL,
	`guardian_registered` integer DEFAULT false NOT NULL,
	`bypass` text,
	`first_seen` integer NOT NULL,
	`last_scan` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scan_targets_kind_name` ON `scan_targets` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `idx_scan_targets_last_scan` ON `scan_targets` (`last_scan`);