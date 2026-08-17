CREATE TABLE `model_substitutions` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`from_model` text NOT NULL,
	`to_model` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_substitutions_project_from` ON `model_substitutions` (`project`,`from_model`);