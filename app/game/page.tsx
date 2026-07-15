"use client";

import { BarChart3, CalendarDays, Play, RotateCcw, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type GameMode = "free" | "daily";
type GameStatus = "active" | "won" | "lost";
type LetterState = "correct" | "present" | "absent";

type GuessFeedback = {
  letter: string;
  normalizedLetter: string;
  state: LetterState;
};

type PublicGuess = {
  guess: string;
  feedback: GuessFeedback[];
  position: number;
};

type PublicGame = {
  id: string;
  mode: GameMode;
  length: number;
  maxGuesses: number;
  attemptsUsed: number;
  status: GameStatus;
  score: number;
  dailyDate: string | null;
  guesses: PublicGuess[];
  word?: string;
};

type HistoryItem = {
  id: string;
  mode: GameMode;
  length: number;
  maxGuesses: number;
  attemptsUsed: number;
  status: GameStatus;
  score: number;
  word: string | null;
};

type LeaderboardRow = {
  games: number;
  rank: number;
  rankScore: number;
  streak: number;
  totalScore: number;
  userId: string;
  winRate: number;
  wins: number;
};

const stateClass: Record<LetterState, string> = {
  absent:
    "border-zinc-300 bg-zinc-200 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  correct: "border-emerald-500 bg-emerald-600 text-white",
  present: "border-amber-500 bg-amber-500 text-white",
};

function emptyRows(game: PublicGame | null, currentGuess: string) {
  if (!game) {
    return [];
  }

  const rows: Array<{
    key: string;
    cells: Array<{ key: string; letter: string }>;
    feedback?: GuessFeedback[];
  }> = game.guesses.map((guess) => ({
    cells: guess.feedback.map((item, cellIndex) => ({
      key: `${guess.position}-${item.normalizedLetter}-${cellIndex}`,
      letter: item.letter,
    })),
    feedback: guess.feedback,
    key: String(guess.position),
  }));

  if (game.status === "active" && rows.length < game.maxGuesses) {
    rows.push({
      cells: currentGuess
        .padEnd(game.length, " ")
        .slice(0, game.length)
        .split("")
        .map((letter, cellIndex) => ({
          key: `current-${cellIndex}`,
          letter,
        })),
      key: "current",
    });
  }

  while (rows.length < game.maxGuesses) {
    const rowNumber = rows.length;
    rows.push({
      cells: Array.from({ length: game.length }, (_value, cellIndex) => ({
        key: `empty-${rowNumber}-${cellIndex}`,
        letter: " ",
      })),
      key: `empty-${rowNumber}`,
    });
  }

  return rows;
}

function shortUser(id: string) {
  return id.slice(0, 8);
}

function normalizeInput(value: string) {
  return value
    .toLocaleLowerCase("fr-CA")
    .replace(/[^a-zàâäçéèêëîïôöùûüÿœæ]/gi, "");
}

export default function GamePage() {
  const [mode, setMode] = useState<GameMode>("free");
  const [length, setLength] = useState(5);
  const [maxGuesses, setMaxGuesses] = useState(6);
  const [game, setGame] = useState<PublicGame | null>(null);
  const [guess, setGuess] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [leaderboards, setLeaderboards] = useState<{
    global: LeaderboardRow[];
    daily: LeaderboardRow[];
  }>({ daily: [], global: [] });

  const rows = useMemo(() => emptyRows(game, guess), [game, guess]);

  const refreshMeta = useCallback(async () => {
    const [historyResponse, leaderboardResponse] = await Promise.all([
      fetch("/api/game/history"),
      fetch("/api/game/leaderboard"),
    ]);

    if (historyResponse.ok) {
      const data = await historyResponse.json();
      setHistory(data.history ?? []);
    }

    if (leaderboardResponse.ok) {
      const data = await leaderboardResponse.json();
      setLeaderboards({
        daily: data.daily ?? [],
        global: data.global ?? [],
      });
    }
  }, []);

  useEffect(() => {
    refreshMeta().catch(() => undefined);
  }, [refreshMeta]);

  const startNewGame = useCallback(
    async (nextMode: GameMode) => {
      setLoading(true);
      setMessage("");
      setGuess("");

      try {
        const response = await fetch("/api/game/start", {
          body: JSON.stringify({ length, maxGuesses, mode: nextMode }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const data = await response.json();

        if (!response.ok) {
          setMessage(data.error ?? "Impossible de lancer la partie.");
          return;
        }

        setGame(data.game);
        setMode(nextMode);
        if (data.game.status === "won") {
          setMessage("Mot du jour deja reussi.");
        } else if (data.game.status === "lost") {
          setMessage(`Mot du jour termine. Le mot etait ${data.game.word}.`);
        }
        await refreshMeta();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Erreur reseau.");
      } finally {
        setLoading(false);
      }
    },
    [length, maxGuesses, refreshMeta]
  );

  const startFreeGame = useCallback(() => {
    startNewGame("free").catch(() => undefined);
  }, [startNewGame]);

  const startDailyGame = useCallback(() => {
    startNewGame("daily").catch(() => undefined);
  }, [startNewGame]);

  const restartGame = useCallback(() => {
    startNewGame(mode).catch(() => undefined);
  }, [mode, startNewGame]);

  const handleModeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setMode(event.target.value as GameMode);
    },
    []
  );

  const handleLengthChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setLength(Number(event.target.value));
    },
    []
  );

  const handleMaxGuessesChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setMaxGuesses(Number(event.target.value));
    },
    []
  );

  const handleGuessChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setGuess(normalizeInput(event.target.value).slice(0, game?.length ?? 10));
    },
    [game?.length]
  );

  async function submitGuess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (game?.status !== "active") {
      return;
    }

    const cleanGuess = normalizeInput(guess);
    if (cleanGuess.length !== game.length) {
      setMessage(`Entre exactement ${game.length} lettres.`);
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/game/guess", {
        body: JSON.stringify({ gameId: game.id, guess: cleanGuess }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        setMessage(data.error ?? "Essai refuse.");
        return;
      }

      setGame(data.game);
      setGuess("");

      if (data.game.status === "won") {
        setMessage(
          `Gagne en ${data.game.attemptsUsed} essais. Score ${data.game.score}.`
        );
        await refreshMeta();
      } else if (data.game.status === "lost") {
        setMessage(`Perdu. Le mot etait ${data.game.word}.`);
        await refreshMeta();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Erreur reseau.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-medium text-muted-foreground text-sm">Jeu IA</p>
            <h1 className="font-semibold text-3xl tracking-normal">
              Devine le mot
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={loading} onClick={startFreeGame} type="button">
              <Play />
              Partie libre
            </Button>
            <Button
              disabled={loading}
              onClick={startDailyGame}
              type="button"
              variant="secondary"
            >
              <CalendarDays />
              Mot du jour
            </Button>
          </div>
        </header>

        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            <div className="grid gap-3 border-b border-border pb-5 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="font-medium text-sm">Mode</span>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-input/30 px-3 text-sm"
                  onChange={handleModeChange}
                  value={mode}
                >
                  <option value="free">Partie libre</option>
                  <option value="daily">Mot du jour</option>
                </select>
              </label>
              <label className="space-y-1" htmlFor="game-length">
                <span className="font-medium text-sm">Lettres</span>
                <Input
                  id="game-length"
                  max={10}
                  min={4}
                  onChange={handleLengthChange}
                  type="number"
                  value={length}
                />
              </label>
              <label className="space-y-1" htmlFor="game-guesses">
                <span className="font-medium text-sm">Chances</span>
                <Input
                  id="game-guesses"
                  max={10}
                  min={3}
                  onChange={handleMaxGuessesChange}
                  type="number"
                  value={maxGuesses}
                />
              </label>
            </div>

            <div className="flex justify-center overflow-x-auto py-2">
              {game ? (
                <div
                  className="grid gap-2"
                  style={{
                    gridTemplateRows: `repeat(${game.maxGuesses}, minmax(0, 1fr))`,
                  }}
                >
                  {rows.map((row) => (
                    <div
                      className="grid gap-2"
                      key={row.key}
                      style={{
                        gridTemplateColumns: `repeat(${game.length}, minmax(42px, 56px))`,
                      }}
                    >
                      {row.cells.map((cell, index) => {
                        const state = row.feedback?.[index]?.state;
                        return (
                          <div
                            className={`flex aspect-square items-center justify-center rounded-md border-2 font-bold text-xl uppercase ${
                              state
                                ? stateClass[state]
                                : "border-zinc-300 bg-background dark:border-zinc-700"
                            }`}
                            key={cell.key}
                          >
                            {cell.letter.trim()}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[320px] w-full items-center justify-center border-y border-border text-muted-foreground">
                  Lance une partie pour generer un mot avec Claude.
                </div>
              )}
            </div>

            <form className="flex gap-2" onSubmit={submitGuess}>
              <Input
                disabled={game?.status !== "active" || loading}
                maxLength={game?.length ?? 10}
                onChange={handleGuessChange}
                placeholder={
                  game ? `${game.length} lettres` : "Lance une partie"
                }
                value={guess}
              />
              <Button
                disabled={game?.status !== "active" || loading}
                type="submit"
              >
                Valider
              </Button>
              <Button
                disabled={loading}
                onClick={restartGame}
                type="button"
                variant="outline"
              >
                <RotateCcw />
              </Button>
            </form>

            {message ? (
              <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                {message}
              </p>
            ) : null}
          </div>

          <aside className="space-y-8">
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Trophy className="size-4" />
                <h2 className="font-semibold">Classement global</h2>
              </div>
              <Leaderboard rows={leaderboards.global} />
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="size-4" />
                <h2 className="font-semibold">Mot du jour</h2>
              </div>
              <Leaderboard rows={leaderboards.daily} />
            </section>

            <section className="space-y-3">
              <h2 className="font-semibold">Historique</h2>
              <div className="space-y-2">
                {history.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucune partie terminee.
                  </p>
                ) : (
                  history.slice(0, 8).map((item) => (
                    <div
                      className="flex items-center justify-between border-b border-border py-2 text-sm"
                      key={item.id}
                    >
                      <div>
                        <p className="font-medium">
                          {item.mode === "daily" ? "Jour" : "Libre"} ·{" "}
                          {item.length} lettres
                        </p>
                        <p className="text-muted-foreground">
                          {item.status === "active"
                            ? "En cours"
                            : (item.word ?? "Terminee")}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{item.score}</p>
                        <p className="text-muted-foreground">
                          {item.attemptsUsed}/{item.maxGuesses}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}

function Leaderboard({ rows }: { rows: LeaderboardRow[] }) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm">Aucun score.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div
          className="grid grid-cols-[32px_1fr_auto] items-center gap-3 border-b border-border py-2 text-sm"
          key={`${row.userId}-${row.rank}`}
        >
          <span className="font-semibold">{row.rank}</span>
          <div>
            <p className="font-medium">{shortUser(row.userId)}</p>
            <p className="text-muted-foreground">
              {row.wins}/{row.games} · {Math.round(row.winRate * 100)}% · serie{" "}
              {row.streak}
            </p>
          </div>
          <span className="font-semibold">{row.rankScore}</span>
        </div>
      ))}
    </div>
  );
}
