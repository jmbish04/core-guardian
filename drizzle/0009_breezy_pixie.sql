CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_type` text DEFAULT 'unknown' NOT NULL,
	`alert_name` text,
	`text` text,
	`severity` text,
	`account_id` text,
	`payload` text,
	`verified` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL
);
