"use client";

import type { DataUIPart } from "ai";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { CustomUIDataTypes, WaitingStatusData } from "@/lib/types";

type DataStreamContextValue = {
  dataStream: DataUIPart<CustomUIDataTypes>[];
  setDataStream: React.Dispatch<
    React.SetStateAction<DataUIPart<CustomUIDataTypes>[]>
  >;
  waitingStatus: WaitingStatusData | undefined;
  setWaitingStatus: React.Dispatch<
    React.SetStateAction<WaitingStatusData | undefined>
  >;
  generationElapsedMs: number;
  generationStartedAt: number | null;
  markGenerationFinished: (outcome: "completed" | "error" | "stopped") => void;
  markGenerationStarted: () => void;
  generationOutcome: "idle" | "active" | "completed" | "error" | "stopped";
};

const DataStreamContext = createContext<DataStreamContextValue | null>(null);

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [dataStream, setDataStream] = useState<DataUIPart<CustomUIDataTypes>[]>(
    []
  );
  const [waitingStatus, setWaitingStatus] = useState<WaitingStatusData>();
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(
    null
  );
  const [generationElapsedMs, setGenerationElapsedMs] = useState(0);
  const [generationOutcome, setGenerationOutcome] = useState<
    "idle" | "active" | "completed" | "error" | "stopped"
  >("idle");

  const markGenerationStarted = useCallback(() => {
    // Each submitted message owns an independent elapsed-time counter.
    setGenerationStartedAt(Date.now());
    setGenerationElapsedMs(0);
    setGenerationOutcome("active");
  }, []);

  const markGenerationFinished = useCallback(
    (outcome: "completed" | "error" | "stopped") => {
      if (generationStartedAt) {
        setGenerationElapsedMs(Date.now() - generationStartedAt);
      }
      setGenerationOutcome(outcome);
    },
    [generationStartedAt]
  );

  useEffect(() => {
    if (generationOutcome !== "active" || generationStartedAt === null) {
      return;
    }

    const timer = window.setInterval(() => {
      setGenerationElapsedMs(Date.now() - generationStartedAt);
    }, 250);

    return () => window.clearInterval(timer);
  }, [generationOutcome, generationStartedAt]);

  const value = useMemo(
    () => ({
      dataStream,
      generationElapsedMs,
      generationOutcome,
      generationStartedAt,
      markGenerationFinished,
      markGenerationStarted,
      setDataStream,
      setWaitingStatus,
      waitingStatus,
    }),
    [
      dataStream,
      generationElapsedMs,
      generationOutcome,
      generationStartedAt,
      waitingStatus,
      markGenerationFinished,
      markGenerationStarted,
    ]
  );

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function useDataStream() {
  const context = useContext(DataStreamContext);
  if (!context) {
    throw new Error("useDataStream must be used within a DataStreamProvider");
  }
  return context;
}
