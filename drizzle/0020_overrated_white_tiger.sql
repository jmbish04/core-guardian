CREATE TABLE `ai_router_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`project` text NOT NULL,
	`importance` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`mode` text NOT NULL,
	`gateway` text,
	`tokens_in` real DEFAULT 0 NOT NULL,
	`tokens_out` real DEFAULT 0 NOT NULL,
	`tokens_in_cost` real DEFAULT 0 NOT NULL,
	`tokens_out_cost` real DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`is_error` integer DEFAULT false NOT NULL,
	`error_message` text,
	`is_circuit_breaker` integer DEFAULT false NOT NULL,
	`circuit_broken_message` text,
	`cost_row_id` text,
	`payload_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_router_req_project` ON `ai_router_requests` (`project`);--> statement-breakpoint
CREATE INDEX `idx_ai_router_req_model` ON `ai_router_requests` (`model`);--> statement-breakpoint
CREATE INDEX `idx_ai_router_req_at` ON `ai_router_requests` (`at`);