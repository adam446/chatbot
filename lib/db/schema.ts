import type { InferSelectModel } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  integer,
  json,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const user = pgTable("User", {
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  email: varchar("email", { length: 64 }).notNull(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  image: text("image"),
  isAnonymous: boolean("isAnonymous").notNull().default(false),
  name: text("name"),
  password: varchar("password", { length: 64 }),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export type User = InferSelectModel<typeof user>;

export const chat = pgTable("Chat", {
  createdAt: timestamp("createdAt").notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  title: text("title").notNull(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  visibility: varchar("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("private"),
});

export type Chat = InferSelectModel<typeof chat>;

export const message = pgTable("Message_v2", {
  attachments: json("attachments").notNull(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  createdAt: timestamp("createdAt").notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  parts: json("parts").notNull(),
  role: varchar("role").notNull(),
});

export type DBMessage = InferSelectModel<typeof message>;

export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    isUpvoted: boolean("isUpvoted").notNull(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.messageId] }),
  })
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    content: text("content"),
    createdAt: timestamp("createdAt").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    kind: varchar("text", { enum: ["text", "code", "image", "sheet"] })
      .notNull()
      .default("text"),
    title: text("title").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
  })
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    createdAt: timestamp("createdAt").notNull(),
    description: text("description"),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    documentId: uuid("documentId").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    isResolved: boolean("isResolved").notNull().default(false),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
    pk: primaryKey({ columns: [table.id] }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const stream = pgTable(
  "Stream",
  {
    chatId: uuid("chatId").notNull(),
    createdAt: timestamp("createdAt").notNull(),
    id: uuid("id").notNull().defaultRandom(),
  },
  (table) => ({
    chatRef: foreignKey({
      columns: [table.chatId],
      foreignColumns: [chat.id],
    }),
    pk: primaryKey({ columns: [table.id] }),
  })
);

export type Stream = InferSelectModel<typeof stream>;

export const documentChunk = pgTable("DocumentChunk", {
  blobUrl: text("blobUrl").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  embedding: vector("embedding", { dimensions: 512 }),
  fileName: text("fileName").notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
});

export type DocumentChunk = InferSelectModel<typeof documentChunk>;

export const wordGameDailyWord = pgTable(
  "WordGameDailyWord",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    date: varchar("date", { length: 10 }).notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    length: integer("length").notNull(),
    normalizedWord: varchar("normalizedWord", { length: 32 }).notNull(),
    word: varchar("word", { length: 32 }).notNull(),
  },
  (table) => ({
    dailyWordIdx: uniqueIndex("WordGameDailyWord_date_length_idx").on(
      table.date,
      table.length
    ),
  })
);

export type WordGameDailyWord = InferSelectModel<typeof wordGameDailyWord>;

export const wordGame = pgTable("WordGame", {
  attemptsUsed: integer("attemptsUsed").notNull().default(0),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  dailyDate: varchar("dailyDate", { length: 10 }),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  length: integer("length").notNull(),
  maxGuesses: integer("maxGuesses").notNull(),
  mode: varchar("mode", { enum: ["free", "daily"] }).notNull(),
  normalizedWord: varchar("normalizedWord", { length: 32 }).notNull(),
  score: real("score").notNull().default(0),
  status: varchar("status", { enum: ["active", "won", "lost"] })
    .notNull()
    .default("active"),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  word: varchar("word", { length: 32 }).notNull(),
});

export type WordGame = InferSelectModel<typeof wordGame>;

export const wordGameGuess = pgTable("WordGameGuess", {
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  feedback: json("feedback").notNull(),
  gameId: uuid("gameId")
    .notNull()
    .references(() => wordGame.id),
  guess: varchar("guess", { length: 32 }).notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  normalizedGuess: varchar("normalizedGuess", { length: 32 }).notNull(),
  position: integer("position").notNull(),
});

export type WordGameGuess = InferSelectModel<typeof wordGameGuess>;
