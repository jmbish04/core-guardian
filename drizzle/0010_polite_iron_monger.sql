CREATE TABLE `pricing_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`scrape_run_id` text NOT NULL,
	`product` text NOT NULL,
	`metric` text NOT NULL,
	`unit_price` real NOT NULL,
	`per_units` real DEFAULT 1 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`included` real,
	`effective_from` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scrape_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`product` text NOT NULL,
	`status` text NOT NULL,
	`method` text NOT NULL,
	`markdown` text,
	`raw_json` text,
	`revisions_written` integer DEFAULT 0 NOT NULL,
	`error` text,
	`ran_at` integer NOT NULL
);
