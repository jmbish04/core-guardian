CREATE TABLE `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`probes_ok` integer DEFAULT 0 NOT NULL,
	`probes_failed` integer DEFAULT 0 NOT NULL,
	`alerts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text
);
