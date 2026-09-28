export type Page = { src: string; thumb: string; w: number; h: number };
export type Issue = { id: string; number: number | null; title: string | null; pages: Page[] };

/** The ten trade collections plus the specials, which is how the shelves are arranged. */
export const ARCS = [
  { name: "Back on the Street", from: 1, to: 6 },
  { name: "Lust for Life", from: 7, to: 12 },
  { name: "Year of the Bastard", from: 13, to: 18 },
  { name: "The New Scum", from: 19, to: 24 },
  { name: "Lonely City", from: 25, to: 30 },
  { name: "Gouge Away", from: 31, to: 36 },
  { name: "Spider's Thrash", from: 37, to: 42 },
  { name: "Dirge", from: 43, to: 48 },
  { name: "The Cure", from: 49, to: 54 },
  { name: "One More Time", from: 55, to: 60 },
];

export function shelves(issues: Issue[]) {
  return [
    ...ARCS.map((arc) => ({
      name: arc.name,
      label: `#${arc.from}–${arc.to}`,
      issues: issues.filter((i) => i.number !== null && i.number >= arc.from && i.number <= arc.to),
    })),
    { name: "Specials", label: "One-shots", issues: issues.filter((i) => i.number === null) },
  ];
}

export function arcOf(issue: Issue) {
  return issue.number === null
    ? "Specials"
    : ARCS.find((a) => issue.number! >= a.from && issue.number! <= a.to)?.name;
}

export function label(issue: Issue) {
  return issue.number === null ? issue.title! : `#${issue.number}`;
}

export const pageUrl = (p: string) => `/pages/${p}`;

/**
 * What a screen reader is told about each page: the lettering, transcribed by
 * scripts/ocr.py, and where scripts/describe.py has run, what the page shows.
 */
export type Words = { text: string[]; scene?: string }[];

async function json<T>(url: string) {
  const res = await fetch(url).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : undefined;
}

export async function loadWords(id: string): Promise<Words> {
  const [text, scene] = await Promise.all([
    json<string[][]>(pageUrl(`${id}/text.json`)),
    json<string[]>(pageUrl(`${id}/scene.json`)),
  ]);
  return (text ?? []).map((t, i) => ({ text: t, scene: scene?.[i] }));
}

export function pageWords(i: number, page: Words[number] | undefined) {
  if (!page) return `Page ${i + 1}.`;
  const lettering = page.text.length ? page.text.map((t) => `“${t}”`).join(" ") : "No lettering.";
  return [`Page ${i + 1}.`, page.scene, lettering].filter(Boolean).join(" ");
}
