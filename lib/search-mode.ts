export type SearchMode = "off" | "search" | "deep";

export function getAutomaticSearchMode(query: string): SearchMode {
  const normalized = query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  if (
    /\b(deep search|recherche approfondie|recherche profonde)\b/.test(
      normalized
    )
  ) {
    return "deep";
  }

  if (
    /\b(search|recherche|chercher|cherche|verifie|verifier|verify|look up|lookup|en ligne|online|current|actuel|recente?|latest|source)\b/.test(
      normalized
    )
  ) {
    return "search";
  }

  if (
    /\b(premier ministre|prime minister|president|ceo|mayor|maire|current leader)\b/.test(
      normalized
    )
  ) {
    return "search";
  }

  if (/\b(qui est le|qui est la|who is the)\b/.test(normalized)) {
    return "search";
  }

  return "off";
}
