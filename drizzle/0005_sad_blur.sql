CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`action_taken` text NOT NULL,
	`timestamp` integer NOT NULL
);
