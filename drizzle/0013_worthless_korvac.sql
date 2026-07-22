CREATE TABLE `action_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`service` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`audit` text,
	`drive_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`verify_result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`completed_at` integer
);
