CREATE TABLE `d1_table_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`database_uuid` text NOT NULL,
	`database_name` text DEFAULT '' NOT NULL,
	`table_name` text NOT NULL,
	`time_column` text DEFAULT '' NOT NULL,
	`cutoff_value` text DEFAULT '' NOT NULL,
	`cutoff_is_num` integer DEFAULT false NOT NULL,
	`max_rowid` integer DEFAULT 0 NOT NULL,
	`archived_rows` integer DEFAULT 0 NOT NULL,
	`drive_file_id` text DEFAULT '' NOT NULL,
	`drive_url` text DEFAULT '' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`content_hash` text DEFAULT '' NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verified_rows` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`trimmed` integer DEFAULT false NOT NULL,
	`trimmed_rows` integer DEFAULT 0 NOT NULL,
	`trimmed_at` integer,
	`reclaimed_bytes` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_d1_table_archives_db` ON `d1_table_archives` (`database_uuid`);--> statement-breakpoint
CREATE INDEX `idx_d1_table_archives_created` ON `d1_table_archives` (`created_at`);