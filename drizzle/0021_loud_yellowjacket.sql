CREATE TABLE `circuit_break_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_identification` text,
	`scope` text,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`jules_pr` text,
	`actions_taken` text,
	`recommendation` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_circuit_break_events_status_created` ON `circuit_break_events` (`status`,`created_at`);