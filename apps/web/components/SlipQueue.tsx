"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalStub } from "@/components/Decision";
import { Receipt } from "@/components/Receipt";
import { useStore } from "@/lib/store";
import type { PurchaseRequest } from "@/lib/types";

// How long a decided slip stays put showing its stamp, then how long it takes
// to fold away while the slips to its right slide left into its place.
const HOLD_MS = 1100;
const COLLAPSE_MS = 380;

type Slot = { id: string; leaving: boolean };

/**
 * A single row of pending receipts. Three fit across a wide screen; the rest
 * wait offscreen to the right. When one is decided it keeps its place long
 * enough to show the stamp, then collapses so everything behind it flows left.
 */
export function SlipQueue({ requests, empty }: { requests: PurchaseRequest[]; empty: React.ReactNode }) {
  const store = useStore();
  const [slots, setSlots] = useState<Slot[]>(() => requests.map((r) => ({ id: r.id, leaving: false })));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());
  const pendingKey = requests.map((r) => r.id).join(",");

  // New requests join the end of the row.
  useEffect(() => {
    setSlots((cur) => {
      const known = new Set(cur.map((s) => s.id));
      const added = requests.filter((r) => !known.has(r.id)).map((r) => ({ id: r.id, leaving: false }));
      return added.length ? [...cur, ...added] : cur;
    });
    // pendingKey captures every change to the pending set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  // Anything no longer pending exits: hold to show the stamp, collapse, then drop.
  useEffect(() => {
    const live = new Set(pendingKey.split(","));
    for (const s of slots) {
      if (live.has(s.id) || timers.current.has(s.id)) continue;
      const fold = setTimeout(() => {
        setSlots((c) => c.map((x) => (x.id === s.id ? { ...x, leaving: true } : x)));
      }, HOLD_MS);
      const drop = setTimeout(() => {
        timers.current.delete(s.id);
        setSlots((c) => c.filter((x) => x.id !== s.id));
      }, HOLD_MS + COLLAPSE_MS);
      timers.current.set(s.id, [fold, drop]);
    }
  }, [slots, pendingKey]);

  useEffect(() => {
    const all = timers.current;
    return () => {
      all.forEach((t) => t.forEach(clearTimeout));
      all.clear();
    };
  }, []);

  const rowRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    measure();
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, slots.length]);

  const page = (dir: 1 | -1) => {
    const el = rowRef.current;
    const first = el?.querySelector<HTMLElement>(".slipq__item");
    if (!el || !first) return;
    el.scrollBy({ left: dir * (first.offsetWidth + 28), behavior: "smooth" });
  };

  const waiting = requests.length;
  // Stay mounted until the last decided slip has finished leaving.
  if (slots.length === 0) return <>{empty}</>;
  const scrollable = !(edges.start && edges.end);

  return (
    <div className="slipq">
      {scrollable && (
        <div className="slipq__nav">
          <span className="fine">{waiting} waiting. Scroll for more.</span>
          <button className="btn btn--sm" onClick={() => page(-1)} disabled={edges.start} aria-label="Show earlier receipts">
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button className="btn btn--sm" onClick={() => page(1)} disabled={edges.end} aria-label="Show more receipts">
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <ul
        ref={rowRef}
        className={`slipq__row${edges.end ? "" : " slipq__row--more"}`}
        onScroll={measure}
        tabIndex={scrollable ? 0 : undefined}
        aria-label="Receipts waiting on you"
      >
        {slots.map((s) => {
          const r = store.request(s.id);
          if (!r) return null;
          return (
            <li key={s.id} className={`slipq__item${s.leaving ? " is-leaving" : ""}`} aria-hidden={s.leaving || undefined}>
              <div className="slipq__inner">
                <Receipt request={r} agent={store.agent(r.agentId)} compact>
                  <ApprovalStub request={r} />
                </Receipt>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
