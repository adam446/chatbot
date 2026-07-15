CREATE TABLE IF NOT EXISTS "WordGameDailyWord" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"date" varchar(10) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"length" integer NOT NULL,
	"normalizedWord" varchar(32) NOT NULL,
	"word" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "WordGameDailyWord_date_length_idx"
	ON "WordGameDailyWord" ("date", "length");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "WordGame" (
	"attemptsUsed" integer DEFAULT 0 NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"dailyDate" varchar(10),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"length" integer NOT NULL,
	"maxGuesses" integer NOT NULL,
	"mode" varchar NOT NULL,
	"normalizedWord" varchar(32) NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"userId" uuid NOT NULL REFERENCES "User"("id"),
	"word" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "WordGameGuess" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"feedback" json NOT NULL,
	"gameId" uuid NOT NULL REFERENCES "WordGame"("id"),
	"guess" varchar(32) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalizedGuess" varchar(32) NOT NULL,
	"position" integer NOT NULL
);
