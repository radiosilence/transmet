import { use } from "react";
import { arcOf, label, wordsFor, type Issue } from "./catalogue";

/** The issue as prose: what each page shows, then what is said on it. */
export function TextEdition({ issue }: { issue: Issue }) {
  const pages = use(wordsFor(issue.id));

  return (
    <main className="text-edition">
      <nav>
        <a href="/">Back to the shop</a>
        <a href={`/read/${issue.id}`}>Read the comic</a>
      </nav>
      <h1>Transmetropolitan {label(issue)}</h1>
      {arcOf(issue) && <p className="arc">{arcOf(issue)}</p>}
      {pages.length === 0 && <p>This issue has no text edition yet.</p>}
      {pages.map((page, i) => (
        <section key={i} aria-labelledby={`page-${i + 1}`}>
          <h2 id={`page-${i + 1}`}>Page {i + 1}</h2>
          {page.scene && <p>{page.scene}</p>}
          {page.text.map((line, j) => (
            <p key={j} className="said">
              “{line}”
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
