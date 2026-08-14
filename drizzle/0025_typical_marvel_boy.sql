CREATE TABLE `guardian_projects` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`repo` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_seen` integer NOT NULL,
	`note` text,
	`criticality` text DEFAULT 'normal' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_guardian_projects_last_seen` ON `guardian_projects` (`last_seen`);--> statement-breakpoint
CREATE TABLE `jules_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`dispatch_id` text,
	`project` text,
	`repo` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`session_url` text,
	`pr_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jules_sessions_status` ON `jules_sessions` (`status`);