CREATE TABLE `jules_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`jules_session_id` text NOT NULL,
	`target_id` text,
	`task_type` text DEFAULT 'spend_audit' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`dispatched_at` integer NOT NULL,
	`reported_at` integer,
	`findings` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_jules_dispatches_nonce` ON `jules_dispatches` (`nonce`);--> statement-breakpoint
CREATE INDEX `idx_jules_dispatches_status` ON `jules_dispatches` (`status`);