CREATE TABLE "market_catalysts" (
	"condition_id" text PRIMARY KEY NOT NULL,
	"catalyst_ts" bigint NOT NULL,
	"catalyst_source" text,
	"catalyst_confidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "market_catalysts_cid_idx" ON "market_catalysts" USING btree ("condition_id");