import type { Issue } from "./catalogue";
import { Reader } from "./Reader";
import { usePath } from "./router";
import { Shop } from "./Shop";

export function App({ issues }: { issues: Issue[] }) {
  const path = usePath();
  const id = path.match(/^\/read\/([^/]+)/)?.[1];
  const issue = issues.find((i) => i.id === id);

  return (
    <>
      <Shop issues={issues} />
      {issue && <Reader key={issue.id} issue={issue} issues={issues} />}
    </>
  );
}
