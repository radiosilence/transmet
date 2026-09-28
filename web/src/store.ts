import { create } from "zustand";
import { persist } from "zustand/middleware";

type Progress = { page: number; done: boolean; at: number };

type Shelf = {
  progress: Record<string, Progress>;
  last: string | null;
  saved: Record<string, true>;
  ahead: number;
  read: (id: string, page: number, total: number) => void;
  markSaved: (id: string, saved: boolean) => void;
  setAhead: (n: number) => void;
};

/** Everything about the reader that outlives a visit. Stored per device. */
export const useShelf = create<Shelf>()(
  persist(
    (set) => ({
      progress: {},
      last: null,
      saved: {},
      ahead: 3,
      read: (id, page, total) =>
        set((s) => {
          const prev = s.progress[id];
          return {
            last: id,
            progress: {
              ...s.progress,
              [id]: { page, done: prev?.done || page >= total - 1, at: Date.now() },
            },
          };
        }),
      markSaved: (id, saved) =>
        set((s) => {
          const next = { ...s.saved };
          if (saved) next[id] = true;
          else delete next[id];
          return { saved: next };
        }),
      setAhead: (ahead) => set({ ahead }),
    }),
    { name: "transmet" },
  ),
);

/** Downloads in flight: issue id → fraction done. Not persisted. */
export const useDownloads = create<Record<string, number>>(() => ({}));
