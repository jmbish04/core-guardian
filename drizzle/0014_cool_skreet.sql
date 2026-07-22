CREATE TABLE `ai_model_pricing` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`api_model_name` text NOT NULL,
	`description` text,
	`best_used_for` text,
	`input_price_per_million` real,
	`output_price_per_million` real,
	`cached_input_price_per_million` real,
	`currency` text DEFAULT 'USD' NOT NULL,
	`source_url` text,
	`scraped_at` integer NOT NULL
);
