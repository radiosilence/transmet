import PhotoSwipe, { type SlideData } from "photoswipe";
import { useEffect, useRef, useState } from "react";
import { arcOf, label, pageUrl, pageWords, wordsFor, type Issue, type Words } from "./catalogue";
import { forget, keepAhead, save } from "./offline";
import { navigate } from "./router";
import { useDownloads, useShelf } from "./store";

/** Taps in the outer strips turn the page; the middle toggles the chrome. */
const EDGE = 0.3;

export function Reader({ issue, issues }: { issue: Issue; issues: Issue[] }) {
  const host = useRef<HTMLDivElement>(null);
  const scrubber = useRef<HTMLDivElement>(null);
  const pswp = useRef<PhotoSwipe | null>(null);
  const [index, setIndex] = useState(() => initialPage(issue));
  const [chrome, setChrome] = useState(true);
  const [words, setWords] = useState<{ id: string; pages: Words }>();

  const saved = useShelf((s) => s.saved[issue.id]);
  const downloading = useDownloads((s) => s[issue.id]);
  const next = issues[issues.indexOf(issue) + 1];
  const total = issue.pages.length;
  const atEnd = index >= total;
  const said = words?.id === issue.id && !atEnd ? pageWords(index, words.pages[index]) : undefined;

  // PhotoSwipe is an imperative widget living outside React; this mounts it
  // for the issue and tears it down when the issue changes.
  useEffect(() => {
    const start = initialPage(issue);
    const thumb = document.querySelector<HTMLElement>(`[data-cover="${issue.id}"] img`);
    let closing = false;

    const slides: SlideData[] = issue.pages.map((p, i) => ({
      src: pageUrl(p.src),
      msrc: pageUrl(p.thumb),
      width: p.w,
      height: p.h,
      alt: `Page ${i + 1}`,
    }));
    slides.push({ html: endSlide(issue, next) });

    const lightbox = new PhotoSwipe({
      dataSource: slides,
      index: start,
      appendToEl: host.current!,
      bgOpacity: 1,
      loop: false,
      preload: [1, 4],
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      showHideAnimationType: start === 0 && thumb ? "zoom" : "fade",
      showAnimationDuration: 420,
      hideAnimationDuration: 320,
      zoom: false,
      close: false,
      counter: false,
      arrowPrev: false,
      arrowNext: false,
      pinchToClose: false,
      closeOnVerticalDrag: true,
      clickToCloseNonZoomable: false,
      imageClickAction: false,
      bgClickAction: false,
      doubleTapAction: "zoom",
      // Double-tap lands on a readable panel size: twice the fit for a single
      // page, and full height for a spread so it pans sideways.
      secondaryZoomLevel: (z) => (z.elementSize && z.elementSize.x > z.elementSize.y ? z.fill : z.fit * 2.2),
      maxZoomLevel: (z) => Math.max(z.fit * 6, 1),
      tapAction: (point, event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "next" && next) return navigate(`/read/${next.id}?p=0`, true);
        if (action === "shop") return lightbox.close();
        const x = point.x / window.innerWidth;
        if (x < EDGE) lightbox.prev();
        else if (x > 1 - EDGE) lightbox.next();
        else setChrome((c) => !c);
      },
    });

    // The transcript arrives after the viewer opens; slides built from then on
    // carry it as alt text, and the live region covers the one already showing.
    let loaded: Words | undefined;
    void wordsFor(issue.id).then((pages) => {
      loaded = pages;
      setWords({ id: issue.id, pages });
    });
    lightbox.addFilter("itemData", (data, i) =>
      loaded?.[i] && i < total ? { ...data, alt: pageWords(i, loaded[i]) } : data,
    );
    lightbox.addFilter("thumbEl", (el, _data, i) => (i === 0 && thumb ? thumb : el) as HTMLElement);
    lightbox.addFilter("placeholderSrc", (src, content) => content.data.msrc ?? src);
    lightbox.on("change", () => {
      const i = lightbox.currIndex;
      setIndex(i);
      useShelf.getState().read(issue.id, Math.min(i, total - 1), total);
      history.replaceState(null, "", `/read/${issue.id}?p=${Math.min(i, total - 1)}`);
    });
    lightbox.on("close", () => {
      closing = true;
    });
    lightbox.on("destroy", () => {
      if (closing) navigate("/");
    });

    lightbox.init();
    pswp.current = lightbox;
    useShelf.getState().read(issue.id, start, total);
    keepAhead(issues, issue);

    return () => {
      if (!closing) lightbox.destroy();
    };
  }, [issue, issues, next, total]);

  // Keeps the current page's thumbnail centred in the scrubber as pages turn.
  useEffect(() => {
    scrubber.current
      ?.querySelector(`[data-i="${Math.min(index, total - 1)}"]`)
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index, total, chrome]);

  return (
    <div className={`reader${chrome ? " chrome" : ""}`} ref={host}>
      <div className="bar top">
        <button className="back" onClick={() => pswp.current?.close()} aria-label="Back to the shop">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="title">
          <strong>{label(issue)}</strong>
          <span>{arcOf(issue)}</span>
        </div>
        <a className="keep" href={`/text/${issue.id}`}>
          Text
        </a>
        <button
          className={`keep${saved ? " on" : ""}`}
          onClick={() => void (saved ? forget(issue) : save(issue))}
          disabled={downloading !== undefined}
        >
          {downloading !== undefined ? `${Math.round(downloading * 100)}%` : saved ? "Saved" : "Save"}
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {said}
      </p>

      <div className="bar bottom">
        <div className="count">{atEnd ? "The end" : `${index + 1} / ${total}`}</div>
        <div className="scrubber" ref={scrubber}>
          {issue.pages.map((p, i) => (
            <button
              key={p.src}
              data-i={i}
              className={`${i === index ? "here" : ""}${p.w > p.h ? " spread" : ""}`}
              onClick={() => pswp.current?.goTo(i)}
              aria-label={`Page ${i + 1}`}
            >
              <img src={pageUrl(p.thumb)} loading="lazy" decoding="async" alt="" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function initialPage(issue: Issue) {
  const p = Number(new URLSearchParams(location.search).get("p") ?? 0);
  return Number.isInteger(p) && p >= 0 && p < issue.pages.length ? p : 0;
}

function endSlide(issue: Issue, next: Issue | undefined) {
  const nextCover = next ? pageUrl(next.pages[0]!.thumb) : "";
  return `<div class="end">
    <p class="end-kicker">End of ${label(issue)}</p>
    ${
      next
        ? `<button class="end-next" data-action="next">
             <img src="${nextCover}" alt="">
             <span><small>Next up</small><strong>${label(next)}</strong><em>${arcOf(next) ?? ""}</em></span>
           </button>`
        : `<p class="end-done">That's the lot.</p>`
    }
    <button class="end-shop" data-action="shop">Back to the shop</button>
  </div>`;
}
