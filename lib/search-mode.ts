export type SearchMode = "off" | "search" | "deep";

export function isChronologyQuery(query: string) {
  const normalized = query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /\b(chronologie|chronology|historique|history|timeline|par dates?|by dates?|key elements|elements? cles|points? cles|depuis|since|entre \d{4}|from \d{4})\b/.test(
    normalized
  );
}

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

  const asksForChronology = isChronologyQuery(query);
  const asksForMultiAngleResearch =
    /\b(comparer|compare|comparaison|evolution|évolution|impact|causes?|consequences?|conséquences?|disputes?|tensions?|trade war|guerre commerciale)\b/.test(
      normalized
    );

  if (asksForChronology || asksForMultiAngleResearch) {
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
