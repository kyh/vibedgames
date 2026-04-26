CREATE TABLE `invite_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer,
	`max_uses` integer DEFAULT 1,
	`used_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`note` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_code_unique` ON `invite_code` (`code`);--> statement-breakpoint
CREATE INDEX `invite_code_created_by_idx` ON `invite_code` (`created_by`);--> statement-breakpoint
ALTER TABLE `user` ADD `invited_by_code` text;