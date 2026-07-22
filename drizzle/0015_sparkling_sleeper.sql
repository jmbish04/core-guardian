CREATE TABLE `ai_gateway_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`day_start` integer NOT NULL,
	`gateway` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tokens_in` real DEFAULT 0 NOT NULL,
	`tokens_out` real DEFAULT 0 NOT NULL,
	`captured_at` integer NOT NULL
);
