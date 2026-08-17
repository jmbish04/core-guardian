CREATE TABLE `spend_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`built_at` integer NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`total_actual_usd` real DEFAULT 0 NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_spend_rollup_built` ON `spend_rollup` (`built_at`);