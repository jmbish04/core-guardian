CREATE TABLE `ai_usage_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`worker` text NOT NULL,
	`operation_id` text,
	`task_description` text,
	`gateway` text DEFAULT 'direct' NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tokens_in` real DEFAULT 0 NOT NULL,
	`tokens_out` real DEFAULT 0 NOT NULL,
	`priced` text NOT NULL,
	`cost_row_id` text NOT NULL,
	`at` integer NOT NULL,
	`created_at` integer NOT NULL
);
