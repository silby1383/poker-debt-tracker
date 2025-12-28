"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";

type Currency = "USD" | "EUR" | "GBP" | "CAD" | "AUD";

type Player = {
  id: string;
  name: string;
};

type BuyIn = {
  id: string;
  playerId: string;
  amountCents: number;
  createdAtIso: string;
  note?: string;
};

type Payment = {
  fromPlayerId: string;
  toPlayerId: string;
  amountCents: number;
};

type PersistedStateV1 = {
  version: 1;
  view: "setup" | "game" | "cashout" | "settle";
  sessionName: string;
  currency: Currency;
  players: Player[];
  buyIns: BuyIn[];
  cashOutDraftByPlayerId: Record<string, string>;
  isFinalized: boolean;
  isSettled: boolean;
};

type LocalSnapshot = {
  sessionId: string | null;
  sessionToken: string | null;
  state: PersistedStateV1;
};

const CURRENCY_OPTIONS: Array<{ code: Currency; label: string; symbol: string }> =
  [
    { code: "USD", label: "US Dollar (USD)", symbol: "$" },
    { code: "EUR", label: "Euro (EUR)", symbol: "€" },
    { code: "GBP", label: "British Pound (GBP)", symbol: "£" },
    { code: "CAD", label: "Canadian Dollar (CAD)", symbol: "$" },
    { code: "AUD", label: "Australian Dollar (AUD)", symbol: "$" },
  ];

const LOCAL_STORAGE_KEY = "poker:currentSession:v1";

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(16).slice(2)}`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatMoney(amountCents: number, currency: Currency) {
  const amount = amountCents / 100;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function parseAmountToCents(raw: string): number | null {
  const normalized = raw.replace(/[, ]+/g, "").trim();
  if (!normalized) return null;
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  );
}

function computeSettlementPayments(
  namedPlayers: Player[],
  netByPlayerId: Record<string, number>
): Payment[] {
  const creditors = namedPlayers
    .map((p) => ({ playerId: p.id, cents: netByPlayerId[p.id] ?? 0 }))
    .filter((x) => x.cents > 0)
    .sort((a, b) => b.cents - a.cents);

  const debtors = namedPlayers
    .map((p) => ({ playerId: p.id, cents: netByPlayerId[p.id] ?? 0 }))
    .filter((x) => x.cents < 0)
    .map((x) => ({ ...x, cents: -x.cents })) // store as "owed" positive
    .sort((a, b) => b.cents - a.cents);

  const payments: Payment[] = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const pay = Math.min(d.cents, c.cents);

    if (pay > 0) {
      payments.push({
        fromPlayerId: d.playerId,
        toPlayerId: c.playerId,
        amountCents: pay,
      });
    }

    d.cents -= pay;
    c.cents -= pay;

    if (d.cents === 0) i += 1;
    if (c.cents === 0) j += 1;
  }

  return payments;
}

export default function Home() {
  // two clients:
  // - anon: used to INSERT (allowed without token)
  // - authed-by-link: used for SELECT/UPDATE/DELETE (requires token)
  const supabaseAnon = React.useMemo(() => createClient(), []);
  const supabase = React.useMemo(
    () => createClient(),
    []
  );

  const [view, setView] = React.useState<"setup" | "game" | "cashout" | "settle">(
    "setup"
  );

  const [sessionName, setSessionName] = React.useState("");
  const [currency, setCurrency] = React.useState<Currency>("USD");
  const [players, setPlayers] = React.useState<Player[]>([
    { id: newId(), name: "Alex" },
    { id: newId(), name: "Jordan" },
    { id: newId(), name: "Sam" },
  ]);

  const [buyIns, setBuyIns] = React.useState<BuyIn[]>([]);
  const [quickPlayerId, setQuickPlayerId] = React.useState<string>("");
  const [quickAmount, setQuickAmount] = React.useState<string>("");
  const [quickNote, setQuickNote] = React.useState<string>("");

  const [amountDraftByPlayerId, setAmountDraftByPlayerId] = React.useState<
    Record<string, string>
  >({});

  const [cashOutDraftByPlayerId, setCashOutDraftByPlayerId] = React.useState<
    Record<string, string>
  >({});

  const [isFinalized, setIsFinalized] = React.useState(false);
  const [isSettled, setIsSettled] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionToken, setSessionToken] = React.useState<string | null>(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [shareStatus, setShareStatus] = React.useState<
    "idle" | "copied" | "failed"
  >("idle");

  const currencySymbol = React.useMemo(
    () => CURRENCY_OPTIONS.find((c) => c.code === currency)?.symbol ?? "$",
    [currency]
  );

  const canStart =
    players.filter((p) => p.name.trim().length > 0).length >= 2;

  const totalsByPlayerId = React.useMemo(() => {
    const totals: Record<string, number> = {};
    for (const p of players) totals[p.id] = 0;
    for (const b of buyIns) totals[b.playerId] = (totals[b.playerId] ?? 0) + b.amountCents;
    return totals;
  }, [buyIns, players]);

  const tableTotalCents = React.useMemo(() => {
    return Object.values(totalsByPlayerId).reduce((a, b) => a + b, 0);
  }, [totalsByPlayerId]);

  const cashOutCentsByPlayerId = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of players) {
      const cents = parseAmountToCents(cashOutDraftByPlayerId[p.id] ?? "");
      out[p.id] = cents ?? 0;
    }
    return out;
  }, [cashOutDraftByPlayerId, players]);

  const totalCashOutCents = React.useMemo(() => {
    return Object.values(cashOutCentsByPlayerId).reduce((a, b) => a + b, 0);
  }, [cashOutCentsByPlayerId]);

  const totalNetCents = React.useMemo(() => {
    // cash-out - buy-ins (table should reconcile to 0)
    return totalCashOutCents - tableTotalCents;
  }, [tableTotalCents, totalCashOutCents]);

  const netByPlayerId = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of players) {
      out[p.id] = (cashOutCentsByPlayerId[p.id] ?? 0) - (totalsByPlayerId[p.id] ?? 0);
    }
    return out;
  }, [cashOutCentsByPlayerId, players, totalsByPlayerId]);

  const sessionTitle = sessionName.trim() || "Poker Night";

  const namedPlayers = React.useMemo(
    () => players.filter((p) => p.name.trim()),
    [players]
  );

  const payments = React.useMemo(() => {
    return computeSettlementPayments(namedPlayers, netByPlayerId);
  }, [namedPlayers, netByPlayerId]);

  const isLocked = isFinalized || isSettled;

  const persistableState: PersistedStateV1 = React.useMemo(
    () => ({
      version: 1,
      view,
      sessionName,
      currency,
      players,
      buyIns,
      cashOutDraftByPlayerId,
      isFinalized,
      isSettled,
    }),
    [
      buyIns,
      cashOutDraftByPlayerId,
      currency,
      isFinalized,
      isSettled,
      players,
      sessionName,
      view,
    ]
  );

  // Restore from local snapshot on first load (crash recovery)
  React.useEffect(() => {
    const snap = safeJsonParse<LocalSnapshot>(localStorage.getItem(LOCAL_STORAGE_KEY));
    if (!snap || !snap.state || snap.state.version !== 1) return;

    setSessionId(snap.sessionId);
    setSessionToken(snap.sessionToken);

    setView(snap.state.view);
    setSessionName(snap.state.sessionName);
    setCurrency(snap.state.currency);
    setPlayers(snap.state.players);
    setBuyIns(snap.state.buyIns);
    setCashOutDraftByPlayerId(snap.state.cashOutDraftByPlayerId);
    setIsFinalized(snap.state.isFinalized);
    setIsSettled(snap.state.isSettled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep local snapshot updated (so refresh/crash resumes immediately)
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const snap: LocalSnapshot = { sessionId, sessionToken, state: persistableState };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(snap));
    }, 250);

    return () => window.clearTimeout(t);
  }, [persistableState, sessionId, sessionToken]);

  // Background sync to Supabase (debounced) — requires BOTH id + token
  React.useEffect(() => {
    if (!sessionId || !sessionToken) return;

    const t = window.setTimeout(async () => {
      setIsSyncing(true);
      try {
        const client = createClient(sessionToken);
        await client
          .from("poker_sessions")
          .update({
            name: sessionName.trim() ? sessionName.trim() : null,
            currency,
            state: persistableState,
          })
          .eq("id", sessionId);
      } finally {
        setIsSyncing(false);
      }
    }, 900);

    return () => window.clearTimeout(t);
  }, [
    currency,
    persistableState,
    sessionId,
    sessionName,
    sessionToken,
  ]);

  // Fetch latest from Supabase once if we have id + token
  React.useEffect(() => {
    if (!sessionId || !sessionToken) return;

    let cancelled = false;

    (async () => {
      try {
        const client = createClient(sessionToken);
        const { data } = await client
          .from("poker_sessions")
          .select("state, name, currency")
          .eq("id", sessionId)
          .single();

        if (cancelled || !data) return;

        const state = data.state as PersistedStateV1;
        if (!state || state.version !== 1) return;

        setView(state.view);
        setSessionName(state.sessionName ?? (data.name ?? ""));
        setCurrency((state.currency ?? (data.currency as Currency)) as Currency);
        setPlayers(state.players ?? []);
        setBuyIns(state.buyIns ?? []);
        setCashOutDraftByPlayerId(state.cashOutDraftByPlayerId ?? {});
        setIsFinalized(Boolean(state.isFinalized));
        setIsSettled(Boolean(state.isSettled));
      } catch {
        // ignore (offline / not found / unauthorized)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, sessionToken]);

  // --- Share link: load session from URL (?s=<uuid>&t=<token>) once on mount
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const s = url.searchParams.get("s");
    const t = url.searchParams.get("t");
    if (!s || !isUuid(s) || !t) return;

    // If local snapshot already points to this session, do nothing.
    if (sessionId === s && sessionToken === t) return;

    let cancelled = false;

    (async () => {
      try {
        const client = createClient(t);
        const { data } = await client
          .from("poker_sessions")
          .select("state, name, currency")
          .eq("id", s)
          .single();

        if (cancelled || !data) return;

        const state = data.state as PersistedStateV1;
        if (!state || state.version !== 1) return;

        setSessionId(s);
        setSessionToken(t);

        setView(state.view);
        setSessionName(state.sessionName ?? (data.name ?? ""));
        setCurrency((state.currency ?? (data.currency as Currency)) as Currency);
        setPlayers(state.players ?? []);
        setBuyIns(state.buyIns ?? []);
        setCashOutDraftByPlayerId(state.cashOutDraftByPlayerId ?? {});
        setIsFinalized(Boolean(state.isFinalized));
        setIsSettled(Boolean(state.isSettled));
      } catch {
        // ignore invalid / not found / unauthorized
      }
    })();

    return () => {
      cancelled = true;
    };
    // Only on first mount: if user later changes URL, we don't auto-teleport sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureSessionRow(): Promise<{ id: string; token: string }> {
    if (sessionId && sessionToken) return { id: sessionId, token: sessionToken };

    const { data, error } = await supabaseAnon
      .from("poker_sessions")
      .insert({
        name: sessionName.trim() ? sessionName.trim() : null,
        currency,
        state: persistableState,
      })
      .select("id, access_token")
      .single();

    if (error || !data?.id || !data.access_token) {
      throw error ?? new Error("Failed to create session");
    }

    setSessionId(data.id);
    setSessionToken(data.access_token);

    return { id: data.id, token: data.access_token };
  }

  function addBuyIn(playerId: string, amountCents: number, note?: string) {
    setBuyIns((prev) => [
      ...prev,
      {
        id: newId(),
        playerId,
        amountCents,
        createdAtIso: new Date().toISOString(),
        note: note?.trim() ? note.trim() : undefined,
      },
    ]);
  }

  function removeBuyIn(buyInId: string) {
    setBuyIns((prev) => prev.filter((b) => b.id !== buyInId));
  }

  async function copyShareLink() {
    if (!sessionId || !sessionToken) return;

    const url = new URL(window.location.href);
    url.searchParams.set("s", sessionId);
    url.searchParams.set("t", sessionToken);

    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus("copied");
      window.setTimeout(() => setShareStatus("idle"), 1200);
    } catch {
      setShareStatus("failed");
      window.setTimeout(() => setShareStatus("idle"), 1500);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50">
      {/* background */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500/20 via-cyan-400/10 to-fuchsia-500/20 blur-3xl" />
        <div className="absolute bottom-[-180px] left-[-140px] h-[420px] w-[420px] rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="absolute bottom-[-180px] right-[-140px] h-[420px] w-[420px] rounded-full bg-cyan-400/10 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-5xl px-5 py-10 md:py-14">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-200">
              <span
                className={`h-2 w-2 rounded-full ${
                  isSettled ? "bg-cyan-300" : isFinalized ? "bg-amber-300" : "bg-emerald-400"
                }`}
              />
              Poker Night •{" "}
              {view === "setup"
                ? "Setup"
                : view === "game"
                  ? "Buy-ins"
                  : view === "cashout"
                    ? "Cash-outs"
                    : "Settlement"}
              {isSettled ? (
                <span className="ml-1 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[10px] text-cyan-200">
                  Settled
                </span>
              ) : isFinalized ? (
                <span className="ml-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-200">
                  Finalized
                </span>
              ) : null}
            </div>
            <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
              Track buy-ins, cash-outs, and who owes who—without the chaos.
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-neutral-300 md:text-base">
              {view === "setup"
                ? "Create a session, pick a currency, and add players. (Buy-ins and results come next.)"
                : view === "game"
                  ? "Record buy-ins as the game runs. Totals update instantly."
                  : view === "cashout"
                    ? "Enter each player's final cash-out. We'll calculate who is up/down instantly."
                    : "Get a clean list of payments so everyone can settle fast."}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-neutral-200 hover:bg-white/10 sm:w-auto"
              onClick={() => {
                setView("setup");
                setSessionId(null);
                setSessionToken(null);
                setSessionName("");
                setCurrency("USD");
                setPlayers([
                  { id: newId(), name: "Alex" },
                  { id: newId(), name: "Jordan" },
                  { id: newId(), name: "Sam" },
                ]);
                setBuyIns([]);
                setQuickPlayerId("");
                setQuickAmount("");
                setQuickNote("");
                setAmountDraftByPlayerId({});
                setCashOutDraftByPlayerId({});
                setIsFinalized(false);
                setIsSettled(false);
                localStorage.removeItem(LOCAL_STORAGE_KEY);
              }}
            >
              Reset
            </button>

            {view === "setup" ? (
              <button
                type="button"
                disabled={!canStart || isStarting}
                className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                title={
                  canStart ? "Start game" : "Add at least 2 players to continue"
                }
                onClick={async () => {
                  if (!canStart) return;
                  setIsStarting(true);
                  try {
                    await ensureSessionRow();
                    const first = players.find((p) => p.name.trim());
                    setQuickPlayerId(first?.id ?? "");
                    setView("game");
                  } finally {
                    setIsStarting(false);
                  }
                }}
              >
                {isStarting ? "Starting…" : "Start game"}
              </button>
            ) : view === "game" ? (
              <button
                type="button"
                className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 sm:w-auto"
                onClick={() => setView("cashout")}
              >
                Enter cash-outs
              </button>
            ) : view === "cashout" ? (
              <button
                type="button"
                className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 sm:w-auto"
                onClick={() => setView("settle")}
              >
                View settlement
              </button>
            ) : (
              <button
                type="button"
                className="w-full rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-white/15 sm:w-auto"
                onClick={() => setView("cashout")}
              >
                Back to cash-outs
              </button>
            )}
          </div>
        </header>

        {/* subtle sync indicator + share */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
            {sessionId ? `Session: ${sessionId.slice(0, 8)}…` : "Not saved yet"}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
            {isSyncing ? "Syncing…" : "Saved locally"}
          </span>

          {sessionId && sessionToken ? (
            <button
              type="button"
              className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-neutral-200 hover:bg-white/10"
              onClick={copyShareLink}
              title="Copy a link you can send to friends"
            >
              {shareStatus === "copied"
                ? "Link copied"
                : shareStatus === "failed"
                  ? "Copy failed"
                  : "Copy share link"}
            </button>
          ) : (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
              Start game to enable sharing
            </span>
          )}

          {isLocked ? (
            <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-amber-200">
              Locked
            </span>
          ) : null}
        </div>

        {view === "setup" ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* Session card */}
            <section className="lg:col-span-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <h2 className="text-base font-semibold">Session</h2>
                <p className="mt-1 text-sm text-neutral-300">
                  Give it a name (optional) and choose your currency.
                </p>

                <div className="mt-5 space-y-4">
                  <label className="block space-y-2">
                    <span className="text-sm text-neutral-200">Session name</span>
                    <input
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                      placeholder="Friday Night Hold'em"
                      className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none ring-0 focus:border-emerald-400/50 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
                    />
                  </label>

                  <label className="block space-y-2">
                    <span className="text-sm text-neutral-200">Currency</span>
                    <div className="relative">
                      <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value as Currency)}
                        className="w-full appearance-none rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 pr-10 text-sm text-neutral-50 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      >
                        {CURRENCY_OPTIONS.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-neutral-400">
                        ▾
                      </div>
                    </div>
                    <div className="text-xs text-neutral-400">
                      All amounts will be shown in{" "}
                      <span className="font-medium text-neutral-200">
                        {currencySymbol} ({currency})
                      </span>
                      .
                    </div>
                  </label>

                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 p-4">
                    <div className="text-xs text-neutral-400">Preview</div>
                    <div className="mt-1 text-sm text-neutral-100">
                      <span className="font-semibold">
                        {sessionName.trim() || "Poker Night"}
                      </span>{" "}
                      • {players.length} player{players.length === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Players card */}
            <section className="lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Players</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Add/remove players anytime.
                    </p>
                  </div>

                  <button
                    type="button"
                    className="w-full rounded-xl bg-white/10 px-3 py-2 text-sm text-neutral-100 hover:bg-white/15 sm:w-auto"
                    onClick={() =>
                      setPlayers((prev) => [...prev, { id: newId(), name: "" }])
                    }
                    disabled={isLocked}
                    title={isLocked ? "Session is finalized/settled" : undefined}
                  >
                    + Add player
                  </button>
                </div>

                <div className="mt-5 space-y-3">
                  {players.map((p, idx) => {
                    const label = p.name.trim()
                      ? p.name.trim()
                      : `Player ${idx + 1}`;
                    return (
                      <div
                        key={p.id}
                        className="group rounded-2xl border border-white/10 bg-neutral-950/30 p-4"
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-3">
                            <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5">
                              <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-neutral-100">
                                {initials(p.name)}
                              </div>
                            </div>

                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-neutral-100">
                                {label}
                              </div>
                              <div className="text-xs text-neutral-400">
                                Player {idx + 1}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                            disabled={players.length <= 1 || isLocked}
                            title={
                              isLocked ? "Session is finalized/settled" : undefined
                            }
                            onClick={() => {
                              if (isLocked) return;
                              setPlayers((prev) =>
                                prev.filter((x) => x.id !== p.id)
                              );
                              setBuyIns((prev) =>
                                prev.filter((b) => b.playerId !== p.id)
                              );
                              setAmountDraftByPlayerId((prev) => {
                                const copy = { ...prev };
                                delete copy[p.id];
                                return copy;
                              });
                              setCashOutDraftByPlayerId((prev) => {
                                const copy = { ...prev };
                                delete copy[p.id];
                                return copy;
                              });
                              if (quickPlayerId === p.id) setQuickPlayerId("");
                            }}
                          >
                            Remove
                          </button>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <label className="block space-y-2 md:col-span-2">
                            <span className="text-xs text-neutral-300">Name</span>
                            <input
                              value={p.name}
                              disabled={isLocked}
                              onChange={(e) =>
                                setPlayers((prev) =>
                                  prev.map((x) =>
                                    x.id === p.id
                                      ? { ...x, name: e.target.value }
                                      : x
                                  )
                                )
                              }
                              placeholder="e.g. Taylor"
                              className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {isLocked ? (
                  <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    This session is{" "}
                    <span className="font-semibold">
                      {isSettled ? "settled" : "finalized"}
                    </span>
                    . Editing players is disabled.
                  </div>
                ) : !canStart ? (
                  <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Add at least <span className="font-semibold">2 players</span>{" "}
                    with names to start tracking buy-ins.
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
                    Ready. Next we'll add the in-game screen for buy-ins per player.
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : view === "game" ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* Buy-in quick entry + table totals */}
            <section className="lg:col-span-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">{sessionTitle}</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Currency:{" "}
                      <span className="font-medium text-neutral-100">
                        {currencySymbol} ({currency})
                      </span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Table total</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {formatMoney(tableTotalCents, currency)}
                    </div>
                  </div>
                </div>

                <div className="mt-5 rounded-2xl border border-white/10 bg-neutral-950/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">Quick add buy-in</div>
                    {isLocked ? (
                      <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-200">
                        Locked
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3 space-y-3">
                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">Player</span>
                      <select
                        value={quickPlayerId}
                        onChange={(e) => setQuickPlayerId(e.target.value)}
                        className="w-full appearance-none rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      >
                        <option value="" disabled>
                          Select player…
                        </option>
                        {players
                          .filter((p) => p.name.trim())
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name.trim()}
                            </option>
                          ))}
                      </select>
                    </label>

                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">
                        Amount ({currencySymbol})
                      </span>
                      <input
                        inputMode="decimal"
                        value={quickAmount}
                        onChange={(e) => setQuickAmount(e.target.value)}
                        placeholder="50"
                        className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      />
                    </label>

                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">Note (optional)</span>
                      <input
                        value={quickNote}
                        onChange={(e) => setQuickNote(e.target.value)}
                        placeholder="Rebuy / add-on / etc."
                        className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      />
                    </label>

                    <button
                      type="button"
                      className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={
                        isLocked || !quickPlayerId || !parseAmountToCents(quickAmount)
                      }
                      onClick={() => {
                        if (isLocked) return;
                        const cents = parseAmountToCents(quickAmount);
                        if (!quickPlayerId || !cents) return;
                        addBuyIn(quickPlayerId, cents, quickNote);
                        setQuickAmount("");
                        setQuickNote("");
                      }}
                    >
                      Add buy-in
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Players + running totals */}
            <section className="lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Buy-ins</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Add as many buy-ins as needed. Remove mistakes instantly.
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Entries</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {buyIns.length}
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  {players
                    .filter((p) => p.name.trim())
                    .map((p) => {
                      const playerTotal = totalsByPlayerId[p.id] ?? 0;
                      const playerBuyIns = buyIns
                        .filter((b) => b.playerId === p.id)
                        .slice()
                        .reverse();

                      const amountDraft = amountDraftByPlayerId[p.id] ?? "";

                      return (
                        <div
                          key={p.id}
                          className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex items-center gap-3">
                              <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5">
                                <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-neutral-100">
                                  {initials(p.name)}
                                </div>
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-neutral-100">
                                  {p.name.trim()}
                                </div>
                                <div className="text-xs text-neutral-400">
                                  Total buy-ins:{" "}
                                  <span className="font-medium text-neutral-200">
                                    {formatMoney(playerTotal, currency)}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <div className="flex items-center gap-2">
                                <div className="relative">
                                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">
                                    {currencySymbol}
                                  </span>
                                  <input
                                    inputMode="decimal"
                                    value={amountDraft}
                                    onChange={(e) =>
                                      setAmountDraftByPlayerId((prev) => ({
                                        ...prev,
                                        [p.id]: e.target.value,
                                      }))
                                    }
                                    placeholder="50"
                                    className="w-32 rounded-xl border border-white/10 bg-neutral-950/40 py-2 pl-7 pr-3 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                                  />
                                </div>

                                <button
                                  type="button"
                                  className="rounded-xl bg-white/10 px-3 py-2 text-sm font-medium text-neutral-100 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                                  disabled={isLocked || !parseAmountToCents(amountDraft)}
                                  onClick={() => {
                                    if (isLocked) return;
                                    const cents = parseAmountToCents(amountDraft);
                                    if (!cents) return;
                                    addBuyIn(p.id, cents);
                                    setAmountDraftByPlayerId((prev) => ({
                                      ...prev,
                                      [p.id]: "",
                                    }));
                                  }}
                                >
                                  Add
                                </button>
                              </div>

                              <div className="text-xs text-neutral-500">
                                {playerBuyIns.length === 0
                                  ? "No buy-ins yet"
                                  : `${playerBuyIns.length} buy-in${
                                      playerBuyIns.length === 1 ? "" : "s"
                                    }`}
                              </div>
                            </div>
                          </div>

                          {playerBuyIns.length > 0 ? (
                            <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
                              <div className="grid grid-cols-12 bg-white/5 px-3 py-2 text-[11px] text-neutral-300">
                                <div className="col-span-5">Time</div>
                                <div className="col-span-4">Note</div>
                                <div className="col-span-2 text-right">Amount</div>
                                <div className="col-span-1 text-right"> </div>
                              </div>

                              <div className="divide-y divide-white/10">
                                {playerBuyIns.slice(0, 5).map((b) => (
                                  <div
                                    key={b.id}
                                    className="grid grid-cols-12 items-center px-3 py-2 text-sm"
                                  >
                                    <div className="col-span-5 text-xs text-neutral-300">
                                      {new Date(b.createdAtIso).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </div>
                                    <div className="col-span-4 truncate text-xs text-neutral-400">
                                      {b.note ?? "—"}
                                    </div>
                                    <div className="col-span-2 text-right text-xs font-medium text-neutral-100">
                                      {formatMoney(b.amountCents, currency)}
                                    </div>
                                    <div className="col-span-1 text-right">
                                      <button
                                        type="button"
                                        className="rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-white/10 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                                        title={isLocked ? "Locked" : "Remove buy-in"}
                                        disabled={isLocked}
                                        onClick={() => removeBuyIn(b.id)}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              </div>
            </section>
          </div>
        ) : view === "cashout" ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* Summary + reconciliation */}
            <section className="lg:col-span-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">{sessionTitle}</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Results preview (not finalizing yet)
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Currency</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {currencySymbol} ({currency})
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4">
                    <div className="text-xs text-neutral-400">Total buy-ins</div>
                    <div className="mt-1 text-sm font-semibold text-neutral-50">
                      {formatMoney(tableTotalCents, currency)}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4">
                    <div className="text-xs text-neutral-400">Total cash-outs</div>
                    <div className="mt-1 text-sm font-semibold text-neutral-50">
                      {formatMoney(totalCashOutCents, currency)}
                    </div>
                  </div>

                  <div
                    className={`rounded-2xl border p-4 ${
                      totalNetCents === 0
                        ? "border-emerald-400/20 bg-emerald-400/10"
                        : "border-amber-400/20 bg-amber-400/10"
                    }`}
                  >
                    <div
                      className={`text-xs ${
                        totalNetCents === 0
                          ? "text-emerald-100/80"
                          : "text-amber-100/80"
                      }`}
                    >
                      Reconciliation (should be 0)
                    </div>
                    <div
                      className={`mt-1 text-sm font-semibold ${
                        totalNetCents === 0 ? "text-emerald-100" : "text-amber-100"
                      }`}
                    >
                      {totalNetCents === 0
                        ? "Balanced ✓"
                        : `${formatMoney(totalNetCents, currency)} off`}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Cash-out entry + net up/down */}
            <section className="lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Cash-outs</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Enter how much each player leaves the table with.
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Net sum</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {formatMoney(totalNetCents, currency)}
                    </div>
                  </div>
                </div>

                {isLocked ? (
                  <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    This session is{" "}
                    <span className="font-semibold">
                      {isSettled ? "settled" : "finalized"}
                    </span>
                    . Cash-outs are locked.
                  </div>
                ) : null}

                <div className="mt-5 space-y-3">
                  {players
                    .filter((p) => p.name.trim())
                    .map((p) => {
                      const buyInTotal = totalsByPlayerId[p.id] ?? 0;
                      const cashOutDraft = cashOutDraftByPlayerId[p.id] ?? "";
                      const cashOutCents = parseAmountToCents(cashOutDraft) ?? 0;
                      const net = netByPlayerId[p.id] ?? 0;

                      const netStyle =
                        net > 0
                          ? "text-emerald-200"
                          : net < 0
                            ? "text-rose-200"
                            : "text-neutral-200";

                      return (
                        <div
                          key={p.id}
                          className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                              <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5">
                                <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-neutral-100">
                                  {initials(p.name)}
                                </div>
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-neutral-100">
                                  {p.name.trim()}
                                </div>
                                <div className="text-xs text-neutral-400">
                                  Buy-ins:{" "}
                                  <span className="font-medium text-neutral-200">
                                    {formatMoney(buyInTotal, currency)}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                              <div className="relative">
                                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">
                                  {currencySymbol}
                                </span>
                                <input
                                  inputMode="decimal"
                                  value={cashOutDraft}
                                  onChange={(e) =>
                                    setCashOutDraftByPlayerId((prev) => ({
                                      ...prev,
                                      [p.id]: e.target.value,
                                    }))
                                  }
                                  disabled={isLocked}
                                  placeholder="Cash-out"
                                  className="w-40 rounded-xl border border-white/10 bg-neutral-950/40 py-2 pl-7 pr-3 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                                />
                              </div>

                              <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                                <div className="text-[11px] text-neutral-400">Net</div>
                                <div className={`text-sm font-semibold ${netStyle}`}>
                                  {formatMoney(net, currency)}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 text-xs text-neutral-500">
                            Cash-out entered:{" "}
                            <span className="text-neutral-300">
                              {cashOutDraft.trim()
                                ? formatMoney(cashOutCents, currency)
                                : "—"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </section>
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* Settlement summary + actions */}
            <section className="lg:col-span-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Settlement</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Minimal payments to settle the table.
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Table total</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {formatMoney(tableTotalCents, currency)}
                    </div>
                  </div>
                </div>

                <div
                  className={`mt-5 rounded-2xl border p-4 ${
                    totalNetCents === 0
                      ? "border-emerald-400/20 bg-emerald-400/10"
                      : "border-amber-400/20 bg-amber-400/10"
                  }`}
                >
                  <div
                    className={`text-xs ${
                      totalNetCents === 0
                        ? "text-emerald-100/80"
                        : "text-amber-100/80"
                    }`}
                  >
                    Reconciliation
                  </div>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      totalNetCents === 0 ? "text-emerald-100" : "text-amber-100"
                    }`}
                  >
                    {totalNetCents === 0
                      ? "Balanced ✓"
                      : `${formatMoney(totalNetCents, currency)} off`}
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  {!isFinalized ? (
                    <button
                      type="button"
                      className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20"
                      onClick={() => {
                        if (totalNetCents !== 0) {
                          const ok = window.confirm(
                            "Totals don't reconcile to $0. Finalize anyway?"
                          );
                          if (!ok) return;
                        }
                        setIsFinalized(true);
                      }}
                    >
                      Finalize results
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isSettled}
                      className="w-full rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-neutral-100 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => setIsSettled(true)}
                    >
                      {isSettled ? "Settled" : "Mark as settled"}
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Payments list + per-player results */}
            <section className="lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Who pays who</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      {payments.length === 0
                        ? "No payments needed."
                        : "Use this list to settle quickly."}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Payments</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {payments.length}
                    </div>
                  </div>
                </div>

                <div className="mt-5 overflow-hidden rounded-2xl border border-white/10">
                  <div className="grid grid-cols-12 bg-white/5 px-4 py-2 text-[11px] text-neutral-300">
                    <div className="col-span-5">From</div>
                    <div className="col-span-5">To</div>
                    <div className="col-span-2 text-right">Amount</div>
                  </div>

                  <div className="divide-y divide-white/10">
                    {payments.length === 0 ? (
                      <div className="px-4 py-4 text-sm text-neutral-400">
                        Everyone is already even (or cash-outs aren't entered yet).
                      </div>
                    ) : (
                      payments.map((pay) => {
                        const from =
                          players.find((x) => x.id === pay.fromPlayerId)?.name.trim() ??
                          "—";
                        const to =
                          players.find((x) => x.id === pay.toPlayerId)?.name.trim() ??
                          "—";
                        return (
                          <div
                            key={`${pay.fromPlayerId}_${pay.toPlayerId}_${pay.amountCents}`}
                            className="grid grid-cols-12 px-4 py-3 text-sm"
                          >
                            <div className="col-span-5 font-medium text-neutral-100">
                              {from}
                            </div>
                            <div className="col-span-5 font-medium text-neutral-100">
                              {to}
                            </div>
                            <div className="col-span-2 text-right font-semibold text-neutral-50">
                              {formatMoney(pay.amountCents, currency)}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="mt-6">
                  <div className="text-sm font-semibold">Results</div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {namedPlayers.map((pl) => {
                      const net = netByPlayerId[pl.id] ?? 0;
                      const tone =
                        net > 0
                          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                          : net < 0
                            ? "border-rose-400/20 bg-rose-400/10 text-rose-100"
                            : "border-white/10 bg-white/5 text-neutral-200";

                      return (
                        <div key={pl.id} className={`rounded-2xl border p-4 ${tone}`}>
                          <div className="text-xs opacity-80">{pl.name.trim()}</div>
                          <div className="mt-1 text-sm font-semibold">
                            {net > 0 ? "Up " : net < 0 ? "Down " : "Even "}
                            {formatMoney(Math.abs(net), currency)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        <footer className="mt-10 text-xs text-neutral-500">
          {view === "setup"
            ? "Step 1 implemented: session setup, currency selection, and player management (frontend only)."
            : view === "game"
              ? "Step 2 implemented: buy-in tracking with per-player totals + table total (frontend only)."
              : view === "cashout"
                ? "Step 3 implemented: cash-out entry + net profit/loss calculation with reconciliation check (frontend only)."
                : "Step 4 implemented: settlement payments + session finalization and settled status (frontend only)."}
        </footer>
      </div>
    </div>
  );
}
