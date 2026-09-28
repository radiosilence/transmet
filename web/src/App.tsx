import { Suspense } from "react";
import type { Issue } from "./catalogue";
import { Reader } from "./Reader";
import { usePath } from "./router";
import { Shop } from "./Shop";
import { TextEdition } from "./TextEdition";

export function App({ issues }: { issues: Issue[] }) {
  const path = usePath();
  const [, view, id] = path.match(/^\/(read|text)\/([^/]+)/) ?? [];
  const issue = issues.find((i) => i.id === id);

  return (
    <>
      <Shop issues={issues} />
      {issue && view === "read" && <Reader key={issue.id} issue={issue} issues={issues} />}
      {issue && view === "text" && (
        <Suspense>
          <TextEdition issue={issue} />
        </Suspense>
      )}
    </>
  );
}
