import { useEffect, useRef, useState, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Phone width: sensitive approvals are blocked here (Business Requirements 07, responsive). */
export const PHONE_QUERY = "(max-width: 720px)";

/** Current time as state, refreshed on an interval, so render stays pure. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Calls onDismiss on Escape or on a pointer press outside `ref`. With stacked
 * modals (a dialog over a drawer) only the topmost one reacts.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void) {
  const cb = useRef(onDismiss);
  useEffect(() => {
    cb.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return;
    const isTopmost = () => {
      const el = ref.current;
      if (!el || el.getAttribute("aria-modal") !== "true") {
        // Popovers yield to any open modal.
        return document.querySelectorAll('[aria-modal="true"]').length === 0;
      }
      const modals = document.querySelectorAll('[aria-modal="true"]');
      return modals[modals.length - 1] === el;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmost()) cb.current();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && isTopmost()) cb.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, ref]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps keyboard focus inside a modal surface and restores it on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const root = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z?.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a?.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [active, ref]);
}
