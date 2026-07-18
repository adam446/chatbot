import "server-only";

import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  type WordGame,
  wordGame,
  wordGameDailyWord,
  wordGameGuess,
} from "@/lib/db/schema";

const client = postgres(process.env.POSTGRES_URL ?? "", { ssl: "require" });
const db = drizzle(client);

export type GameMode = "free" | "daily";
export type GameStatus = "active" | "won" | "lost";
export type LetterState = "correct" | "present" | "absent";

export type GuessFeedback = {
  letter: string;
  normalizedLetter: string;
  state: LetterState;
};

export type PublicGuess = {
  guess: string;
  feedback: GuessFeedback[];
  position: number;
};

export type PublicGame = {
  id: string;
  mode: GameMode;
  length: number;
  maxGuesses: number;
  attemptsUsed: number;
  status: GameStatus;
  score: number;
  dailyDate: string | null;
  guesses: PublicGuess[];
  createdAt: Date;
  completedAt: Date | null;
  word?: string;
};

const MIN_LENGTH = 4;
const MAX_LENGTH = 10;
const MIN_GUESSES = 3;
const MAX_GUESSES = 10;

const fallbackWords: Record<number, string[]> = {
  4: [
    "aube",
    "bois",
    "brin",
    "ciel",
    "dune",
    "film",
    "four",
    "gout",
    "jour",
    "lait",
    "lune",
    "main",
    "miel",
    "pain",
    "port",
    "rive",
    "rose",
    "vent",
  ],
  5: [
    "arbre",
    "avion",
    "badge",
    "carte",
    "chaud",
    "chien",
    "clown",
    "danse",
    "fleur",
    "fruit",
    "livre",
    "monde",
    "plage",
    "porte",
    "radio",
    "route",
    "rouge",
    "sable",
    "table",
    "vague",
  ],
  6: [
    "animal",
    "argent",
    "bateau",
    "bureau",
    "camion",
    "chemin",
    "crayon",
    "jardin",
    "lettre",
    "orange",
    "papier",
    "soleil",
    "tomate",
    "voyage",
  ],
  7: [
    "banquet",
    "cabinet",
    "courage",
    "dessert",
    "fortune",
    "journal",
    "machine",
    "musique",
    "passage",
    "poisson",
    "respect",
    "village",
    "voiture",
  ],
  8: [
    "batterie",
    "boutique",
    "chocolat",
    "commerce",
    "distance",
    "festival",
    "montagne",
    "question",
    "souvenir",
    "vacances",
    "violence",
  ],
  9: [
    "categorie",
    "continent",
    "important",
    "industrie",
    "magistrat",
    "militaire",
    "politique",
    "president",
    "selection",
    "spectacle",
    "strategie",
    "telephone",
    "tradition",
  ],
  10: [
    "collection",
    "decouverte",
    "generation",
    "impression",
    "navigation",
    "ordinateur",
    "population",
    "protection",
    "restaurant",
    "resolution",
    "television",
  ],
};

export function normalizeWord(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("fr-CA")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z]/g, "");
}

function cleanDisplayWord(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("fr-CA")
    .replace(/[^a-zàâäçéèêëîïôöùûüÿœæ]/gi, "");
}

function validateSettings(length: number, maxGuesses: number) {
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`Length must be between ${MIN_LENGTH} and ${MAX_LENGTH}.`);
  }

  if (
    !Number.isInteger(maxGuesses) ||
    maxGuesses < MIN_GUESSES ||
    maxGuesses > MAX_GUESSES
  ) {
    throw new Error(
      `Max guesses must be between ${MIN_GUESSES} and ${MAX_GUESSES}.`
    );
  }
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Toronto",
    year: "numeric",
  }).format(new Date());
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function getWordPool(length: number) {
  return (fallbackWords[length] ?? []).filter(
    (word) => normalizeWord(word).length === length
  );
}

function pickLocalWord({
  excludedWords,
  length,
  seed,
}: {
  excludedWords?: Set<string>;
  length: number;
  seed?: string;
}) {
  const words = getWordPool(length);
  if (words.length === 0) {
    throw new Error("Could not create a word for this game.");
  }

  const available = words.filter(
    (candidate) => !excludedWords?.has(normalizeWord(candidate))
  );
  const choices = available.length > 0 ? available : words;
  const index = seed
    ? hashString(`${seed}:${length}`) % choices.length
    : Math.floor(Math.random() * choices.length);
  const word = choices[index];

  return { normalizedWord: normalizeWord(word), word };
}

async function getRecentUserWords({
  length,
  userId,
}: {
  length: number;
  userId: string;
}) {
  const recentGames = await db
    .select({ normalizedWord: wordGame.normalizedWord })
    .from(wordGame)
    .where(and(eq(wordGame.userId, userId), eq(wordGame.length, length)))
    .orderBy(desc(wordGame.createdAt))
    .limit(Math.max(20, getWordPool(length).length - 1));

  return new Set(recentGames.map((game) => game.normalizedWord));
}

async function getExistingDailyWord(length: number, date: string) {
  const [dailyWord] = await db
    .select()
    .from(wordGameDailyWord)
    .where(
      and(
        eq(wordGameDailyWord.date, date),
        eq(wordGameDailyWord.length, length)
      )
    )
    .limit(1);

  return dailyWord ?? null;
}

async function getRecentDailyWords(length: number) {
  const recentWords = await db
    .select({ normalizedWord: wordGameDailyWord.normalizedWord })
    .from(wordGameDailyWord)
    .where(eq(wordGameDailyWord.length, length))
    .orderBy(desc(wordGameDailyWord.createdAt))
    .limit(Math.max(20, getWordPool(length).length - 1));

  return new Set(recentWords.map((word) => word.normalizedWord));
}

async function getFreeGameExcludedWords({
  length,
  userId,
}: {
  length: number;
  userId: string;
}) {
  const excludedWords = await getRecentUserWords({ length, userId });
  const dailyWord = await getExistingDailyWord(length, todayKey());

  if (dailyWord) {
    excludedWords.add(dailyWord.normalizedWord);
  }

  return excludedWords;
}

async function getOrCreateDailyWord(length: number, date: string) {
  const existing = await getExistingDailyWord(length, date);

  if (existing) {
    return existing;
  }

  const generated = pickLocalWord({
    excludedWords: await getRecentDailyWords(length),
    length,
    seed: date,
  });
  const [created] = await db
    .insert(wordGameDailyWord)
    .values({
      date,
      length,
      normalizedWord: generated.normalizedWord,
      word: generated.word,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  const [concurrent] = await db
    .select()
    .from(wordGameDailyWord)
    .where(
      and(
        eq(wordGameDailyWord.date, date),
        eq(wordGameDailyWord.length, length)
      )
    )
    .limit(1);

  return concurrent;
}

function toPublicGame(
  game: WordGame,
  guesses: PublicGuess[],
  revealWord = false
): PublicGame {
  return {
    attemptsUsed: game.attemptsUsed,
    completedAt: game.completedAt,
    createdAt: game.createdAt,
    dailyDate: game.dailyDate,
    guesses,
    id: game.id,
    length: game.length,
    maxGuesses: game.maxGuesses,
    mode: game.mode as GameMode,
    score: game.score,
    status: game.status as GameStatus,
    ...(revealWord ? { word: game.word } : {}),
  };
}

async function getPublicGuesses(gameId: string): Promise<PublicGuess[]> {
  const guesses = await db
    .select()
    .from(wordGameGuess)
    .where(eq(wordGameGuess.gameId, gameId))
    .orderBy(wordGameGuess.position);

  return guesses.map((guess) => ({
    feedback: guess.feedback as GuessFeedback[],
    guess: guess.guess,
    position: guess.position,
  }));
}

export async function startGame({
  userId,
  mode,
  length,
  maxGuesses,
}: {
  userId: string;
  mode: GameMode;
  length: number;
  maxGuesses: number;
}) {
  validateSettings(length, maxGuesses);
  const dailyDate = mode === "daily" ? todayKey() : null;

  if (mode === "daily" && dailyDate) {
    const [existing] = await db
      .select()
      .from(wordGame)
      .where(
        and(
          eq(wordGame.userId, userId),
          eq(wordGame.mode, "daily"),
          eq(wordGame.dailyDate, dailyDate),
          eq(wordGame.length, length)
        )
      )
      .orderBy(desc(wordGame.createdAt))
      .limit(1);

    if (existing) {
      return toPublicGame(
        existing,
        await getPublicGuesses(existing.id),
        existing.status !== "active"
      );
    }
  }

  const generated =
    mode === "daily" && dailyDate
      ? await getOrCreateDailyWord(length, dailyDate)
      : pickLocalWord({
          excludedWords: await getFreeGameExcludedWords({
            length,
            userId,
          }),
          length,
        });

  if (!generated) {
    throw new Error("Could not create a word for this game.");
  }

  const [game] = await db
    .insert(wordGame)
    .values({
      dailyDate,
      length,
      maxGuesses,
      mode,
      normalizedWord: generated.normalizedWord,
      userId,
      word: generated.word,
    })
    .returning();

  return toPublicGame(game, []);
}

export function scoreGuess(
  normalizedGuess: string,
  normalizedWord: string,
  displayGuess: string
): GuessFeedback[] {
  const feedback: GuessFeedback[] = normalizedGuess.split("").map((letter) => ({
    letter,
    normalizedLetter: letter,
    state: "absent",
  }));
  const remaining = new Map<string, number>();
  const wordLetters = normalizedWord.split("");
  const guessLetters = normalizedGuess.split("");
  const displayLetters = displayGuess.split("");

  for (let i = 0; i < wordLetters.length; i += 1) {
    if (guessLetters[i] === wordLetters[i]) {
      feedback[i] = {
        letter: displayLetters[i] ?? guessLetters[i],
        normalizedLetter: guessLetters[i],
        state: "correct",
      };
    } else {
      remaining.set(wordLetters[i], (remaining.get(wordLetters[i]) ?? 0) + 1);
    }
  }

  for (let i = 0; i < guessLetters.length; i += 1) {
    if (feedback[i].state === "correct") {
      continue;
    }

    const letter = guessLetters[i];
    const count = remaining.get(letter) ?? 0;
    feedback[i] = {
      letter: displayLetters[i] ?? letter,
      normalizedLetter: letter,
      state: count > 0 ? "present" : "absent",
    };

    if (count > 0) {
      remaining.set(letter, count - 1);
    }
  }

  return feedback;
}

function calculateScore({
  won,
  length,
  maxGuesses,
  attemptsUsed,
}: {
  won: boolean;
  length: number;
  maxGuesses: number;
  attemptsUsed: number;
}) {
  if (!won) {
    return 0;
  }

  const remaining = Math.max(0, maxGuesses - attemptsUsed);
  return Math.round(length * 100 + remaining * 25 + 100);
}

export async function submitGuess({
  userId,
  gameId,
  guess,
}: {
  userId: string;
  gameId: string;
  guess: string;
}) {
  const [game] = await db
    .select()
    .from(wordGame)
    .where(and(eq(wordGame.id, gameId), eq(wordGame.userId, userId)))
    .limit(1);

  if (!game) {
    throw new Error("Game not found.");
  }

  if (game.status !== "active") {
    return toPublicGame(game, await getPublicGuesses(game.id), true);
  }

  const displayGuess = cleanDisplayWord(guess);
  const normalizedGuess = normalizeWord(displayGuess);

  if (normalizedGuess.length !== game.length) {
    throw new Error(`Guess must be ${game.length} letters.`);
  }

  const [existingGuess] = await db
    .select({ id: wordGameGuess.id })
    .from(wordGameGuess)
    .where(
      and(
        eq(wordGameGuess.gameId, game.id),
        eq(wordGameGuess.normalizedGuess, normalizedGuess)
      )
    )
    .limit(1);

  if (existingGuess) {
    throw new Error("Mot deja essaye.");
  }

  const position = game.attemptsUsed + 1;
  const feedback = scoreGuess(
    normalizedGuess,
    game.normalizedWord,
    displayGuess
  );
  const won = normalizedGuess === game.normalizedWord;
  const lost = !won && position >= game.maxGuesses;
  const status: GameStatus = won ? "won" : lost ? "lost" : "active";
  const score = calculateScore({
    attemptsUsed: position,
    length: game.length,
    maxGuesses: game.maxGuesses,
    won,
  });

  await db.insert(wordGameGuess).values({
    feedback,
    gameId: game.id,
    guess: displayGuess,
    normalizedGuess,
    position,
  });

  const [updated] = await db
    .update(wordGame)
    .set({
      attemptsUsed: position,
      completedAt: status === "active" ? null : new Date(),
      score,
      status,
    })
    .where(eq(wordGame.id, game.id))
    .returning();

  return toPublicGame(
    updated,
    await getPublicGuesses(game.id),
    updated.status !== "active"
  );
}

export async function getGameHistory(userId: string) {
  const games = await db
    .select()
    .from(wordGame)
    .where(eq(wordGame.userId, userId))
    .orderBy(desc(wordGame.createdAt))
    .limit(30);

  return games.map((game) => ({
    attemptsUsed: game.attemptsUsed,
    completedAt: game.completedAt,
    createdAt: game.createdAt,
    dailyDate: game.dailyDate,
    id: game.id,
    length: game.length,
    maxGuesses: game.maxGuesses,
    mode: game.mode,
    score: game.score,
    status: game.status,
    word: game.status === "active" ? null : game.word,
  }));
}

function currentWinStreak(games: WordGame[]) {
  let streak = 0;

  for (const game of games) {
    if (game.status === "won") {
      streak += 1;
      continue;
    }
    if (game.status === "lost") {
      break;
    }
  }

  return streak;
}

function buildLeaderboardRows(games: WordGame[]) {
  const byUser = new Map<string, WordGame[]>();

  for (const game of games) {
    const list = byUser.get(game.userId) ?? [];
    list.push(game);
    byUser.set(game.userId, list);
  }

  return [...byUser.entries()]
    .map(([userId, userGames]) => {
      const completed = userGames.filter((game) => game.status !== "active");
      const wins = completed.filter((game) => game.status === "won").length;
      const totalScore = completed.reduce((sum, game) => sum + game.score, 0);
      const winRate = completed.length === 0 ? 0 : wins / completed.length;
      const streak = currentWinStreak(
        [...completed].sort(
          (a, b) =>
            (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)
        )
      );

      return {
        games: completed.length,
        rankScore: Math.round(totalScore + streak * 50 + winRate * 100),
        streak,
        totalScore,
        userId,
        winRate,
        wins,
      };
    })
    .filter((row) => row.games > 0)
    .sort(
      (a, b) =>
        b.rankScore - a.rankScore ||
        b.winRate - a.winRate ||
        b.streak - a.streak
    )
    .slice(0, 10)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function getLeaderboards() {
  const games = await db
    .select()
    .from(wordGame)
    .where(ne(wordGame.status, "active"))
    .orderBy(desc(wordGame.completedAt))
    .limit(500);
  const today = todayKey();

  return {
    daily: buildLeaderboardRows(
      games.filter(
        (game) => game.mode === "daily" && game.dailyDate === today
      ) as WordGame[]
    ),
    global: buildLeaderboardRows(games as WordGame[]),
  };
}
