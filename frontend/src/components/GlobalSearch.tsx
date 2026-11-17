import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useDebounced, useDismiss } from "../hooks/ui";
import { areaForScreen } from "../navigation/navConfig";
import { api } from "../services/api";
import type { SearchHit } from "../types/api";

export function linkForHit(h: SearchHit): string {
  if (h.kind === "payment") return `/payments?payment=${encodeURIComponent(h.id)}`;
  const area = h.screenId ? areaForScreen(h.screenId) : undefined;
  return area ? `${area.path}?screen=${h.screenId}&record=${encodeURIComponent(h.id)}` : "/";
}

/**
 * Global search (Business Requirements §07 top bar) over records the caller
 * may open; the server filters by role and scope. Press "/" to focus.
 */
export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ q: string; items: SearchHit[] }>({ q: "", items: [] });
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 220);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const listId = useId();
  useDismiss(ref, open, () => setOpen(false));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/input|textarea|select/i.test(t.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (dq.length < 2) return;
    const ctrl = new AbortController();
    api.search(dq, ctrl.signal)
      .then((r) => { setResults({ q: dq, items: r.data }); setActive(0); })
      .catch((e: unknown) => { if ((e as Error).name !== "AbortError") setResults({ q: dq, items: [] }); });
    return () => ctrl.abort();
  }, [dq]);

  const loading = dq.length >= 2 && results.q !== dq;
  const shown = dq.length >= 2 && results.q === dq ? results.items : [];
  const go = (h: SearchHit) => {
    setOpen(false);
    setQ("");
    navigate(linkForHit(h));
  };

  return (
    <div className="search" ref={ref} style={{ width: "min(340px, 30vw)" }}>
      <Search size={14} className="lead" aria-hidden="true" />
      <input
        ref={input} className="input" placeholder="Search IDs and records" role="combobox"
        aria-expanded={open && dq.length >= 2} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined} aria-label="Global search"
        value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter" && shown[active]) go(shown[active]);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {!q && <span className="kbd" aria-hidden="true">/</span>}
      {open && dq.length >= 2 && (
        <div className="popover" style={{ left: 0, right: "auto", width: "min(420px, 90vw)" }}>
          <ul className="menu-list" role="listbox" id={listId} aria-label="Search results">
            {loading && <li className="menu-item subtle">Searching…</li>}
            {!loading && !shown.length && <li className="menu-item subtle">No records you can open match “{dq}”.</li>}
            {shown.map((h, i) => (
              <li key={`${h.kind}-${h.id}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                <button className="menu-item" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)} tabIndex={-1}>
                  <span className="chip" style={{ minWidth: 86, justifyContent: "center" }}>{h.kind === "payment" ? "payment" : h.screenId}</span>
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{h.id}</span>
                    <span className="meta">{h.label}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
