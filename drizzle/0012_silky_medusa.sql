CREATE TABLE `drive_folders` (
	`purpose` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text,
	`validated` integer DEFAULT false NOT NULL,
	`error` text,
	`validated_at` integer,
	`updated_at` integer NOT NULL
);
