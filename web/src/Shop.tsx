import { useEffect, useRef, useState, type CSSProperties } from "react";
import { arcOf, label, pageUrl, shelves, type Issue } from "./catalogue";
import { forgetAll, save, usage } from "./offline";
import { navigate } from "./router";
import { useDownloads, useShelf } from "./store";

const open = (issue: Issue, page = 0) => navigate(`/read/${issue.id}?p=${page}`);

export function Shop({ issues }: { issues: Issue[] }) {
  const last = useShelf((s) => s.last);
  const progress = useShelf((s) => s.progress);

  const current = issues.find((i) => i.id === last) ?? issues[0]!;
  const finished = progress[current.id]?.done;
  const pick = finished ? (issues[issues.indexOf(current) + 1] ?? current) : current;
  const at = progress[pick.id];

  return (
    <main className="shop">
      <header className="sign">
        <div className="neon" aria-label="Transmetropolitan">
          <span>Trans</span>
          <span className="flicker">metro</span>
          <span>politan</span>
        </div>
        <p className="hours">Back issues · One title only · Open all night</p>
      </header>

      <section className="counter">
        <div className="stand">
          <Cover issue={pick} big />
        </div>
        <div className="counter-copy">
          <span className="kicker">
            {at && !at.done ? "Pick up where you left off" : last ? "Next on the pile" : "Start here"}
          </span>
          <h1>{label(pick)}</h1>
          <p className="arc">{arcOf(pick)}</p>
          {at && !at.done && (
            <div className="meter" style={{ "--p": (at.page + 1) / pick.pages.length } as CSSProperties}>
              <span>
                Page {at.page + 1} of {pick.pages.length}
              </span>
            </div>
          )}
          <button className="cta" onClick={() => open(pick, at && !at.done ? at.page : 0)}>
            {at && !at.done ? "Keep reading" : "Read"}
          </button>
        </div>
      </section>

      {shelves(issues).map((shelf) => (
        <Shelf key={shelf.name} {...shelf} />
      ))}

      <Till />
    </main>
  );
}

function Shelf({ name, label: range, issues }: { name: string; label: string; issues: Issue[] }) {
  const saved = useShelf((s) => s.saved);
  const downloads = useDownloads();
  const all = issues.every((i) => saved[i.id]);
  const busy = issues.some((i) => i.id in downloads);
  const rack = useRef<HTMLDivElement>(null);
  const slide = (dir: number) =>
    rack.current?.scrollBy({ left: dir * rack.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <section className="shelf">
      <div className="shelf-card">
        <h2>{name}</h2>
        <span className="range">{range}</span>
        <button
          className="take"
          disabled={all || busy}
          onClick={() => issues.forEach((i) => void save(i))}
        >
          {all ? "On this device" : busy ? "Bagging…" : "Take the lot"}
        </button>
      </div>
      <div className="rack-wrap">
        <div className="rack" ref={rack}>
          {issues.map((issue) => (
            <Cover key={issue.id} issue={issue} />
          ))}
        </div>
        <button className="nudge prev" onClick={() => slide(-1)} aria-label={`Earlier in ${name}`}>
          ‹
        </button>
        <button className="nudge next" onClick={() => slide(1)} aria-label={`Later in ${name}`}>
          ›
        </button>
      </div>
      <div className="ledge" />
    </section>
  );
}

function Cover({ issue, big }: { issue: Issue; big?: boolean }) {
  const at = useShelf((s) => s.progress[issue.id]);
  const saved = useShelf((s) => s.saved[issue.id]);
  const downloading = useDownloads((s) => s[issue.id]);
  const cover = issue.pages[0]!;

  return (
    <>
      <button
        className={`cover${big ? " big" : ""}`}
        data-cover={big ? undefined : issue.id}
        onClick={() => open(issue, at && !at.done ? at.page : 0)}
        aria-label={`${label(issue)}${at?.done ? ", read" : ""}`}
      >
        <img
          src={pageUrl(cover.thumb)}
          width={cover.w}
          height={cover.h}
          loading={big ? "eager" : "lazy"}
          decoding="async"
          alt=""
        />
        <span className="bag" />
        <span className="sticker">{issue.number ?? issue.id.toUpperCase()}</span>
        {at && !at.done && (
          <span className="ribbon" style={{ "--p": (at.page + 1) / issue.pages.length } as CSSProperties} />
        )}
        {at?.done && <span className="stamp">Read</span>}
        {downloading !== undefined ? (
          <span className="saving" style={{ "--p": downloading } as CSSProperties} />
        ) : (
          saved && <span className="saved" title="On this device" />
        )}
      </button>
      <a className="sr-only" href={`/text/${issue.id}`}>
        Text edition of {label(issue)}
      </a>
    </>
  );
}

function Till() {
  const ahead = useShelf((s) => s.ahead);
  const setAhead = useShelf((s) => s.setAhead);
  const saved = useShelf((s) => Object.keys(s.saved).length);
  const [used, setUsed] = useState(0);

  // Storage use is the browser's figure and changes outside React, so it is
  // re-read whenever the count of saved issues moves.
  useEffect(() => {
    void usage().then(setUsed);
  }, [saved]);

  return (
    <footer className="till">
      <div className="receipt">
        <div className="row">
          <span>On this device</span>
          <strong>
            {saved} {saved === 1 ? "issue" : "issues"} · {(used / 1e6).toFixed(0)} MB
          </strong>
        </div>
        <div className="row">
          <span>Keep ready ahead</span>
          <span className="stepper">
            <button onClick={() => setAhead(Math.max(0, ahead - 1))} aria-label="Fewer">
              −
            </button>
            <strong>{ahead}</strong>
            <button onClick={() => setAhead(Math.min(12, ahead + 1))} aria-label="More">
              +
            </button>
          </span>
        </div>
        {saved > 0 && (
          <button className="clear" onClick={() => void forgetAll().then(() => usage().then(setUsed))}>
            Clear everything saved
          </button>
        )}
        <p className="thanks">Thank you, come again</p>
      </div>
    </footer>
  );
}
