CREATE TABLE `trim_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`db_uuid` text NOT NULL,
	`db_name` text NOT NULL,
	`table_name` text NOT NULL,
	`key_column` text DEFAULT 'id' NOT NULL,
	`threshold_rows` integer DEFAULT 50000 NOT NULL,
	`keep_rows` integer DEFAULT 20000 NOT NULL,
	`batch_rows` integer DEFAULT 10000 NOT NULL,
	`drive_folder_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_export_path` text,
	`last_rows_exported` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
