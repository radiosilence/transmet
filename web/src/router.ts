import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => {
  addEventListener("popstate", cb);
  return () => removeEventListener("popstate", cb);
};

export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname);

export function navigate(to: string, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}
