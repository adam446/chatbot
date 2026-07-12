"use client";

import { useState } from "react";

export default function DocumentsPage() {
  const [status, setStatus] = useState<
    "idle" | "uploading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }

    setStatus("uploading");
    setMessage("");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/documents/upload", {
        body: formData,
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setMessage(data.error ?? "Upload failed.");
        return;
      }

      setStatus("success");
      setMessage(
        `"${data.fileName}" televerse et decoupe en ${data.chunks} morceaux. L'IA peut maintenant le rechercher.`
      );
      form.reset();
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Televersement echoue. Assurez-vous d'etre connecte."
      );
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div>
          <h1 className="font-bold text-2xl">Televerser un document</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Televersez un fichier <strong>.txt</strong> ou{" "}
            <strong>.md</strong> (max 4 Mo). L'IA pourra le rechercher pendant
            le chat.
          </p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <input
            accept=".txt,.md,text/plain,text/markdown"
            className="block w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            name="file"
            required
            type="file"
          />
          <button
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            disabled={status === "uploading"}
            type="submit"
          >
            {status === "uploading" ? "Televersement..." : "Televerser"}
          </button>
        </form>

        {message && (
          <p
            className={`rounded-lg p-3 text-sm ${
              status === "success"
                ? "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
            }`}
          >
            {message}
          </p>
        )}

        <p className="text-xs text-zinc-400">
          Apres le televersement, retournez au chat et posez une question sur
          le document.
        </p>
      </div>
    </div>
  );
}
