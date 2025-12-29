"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";

const DEBUG = false;
const debug = (...args: unknown[]) => {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(...args);
};

type Currency = "USD";

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

type KnownSession = {
  id: string;
  token: string;
  name: string;
  currency: Currency;
  lastOpenedAtIso: string;
};

type PlayersTemplateV1 = {
  version: 1;
  names: string[];
};

const LOCAL_STORAGE_KEY = "poker:currentSession:v1";
const KNOWN_SESSIONS_KEY = "poker:knownSessions:v1";
const LAST_PLAYERS_KEY = "poker:lastPlayers:v1";

const CURRENCY: Currency = "USD";
const CURRENCY_SYMBOL = "$";
const DEFAULT_BUY_IN = "20";

const DEFAULT_PLAYER_NAMES = ["Alex", "Jordan", "Sam"] as const;

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(16).slice(2)}`;
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function buildPlayersFromNames(names: string[]): Player[] {
  const normalized = names.length > 0 ? names : [...DEFAULT_PLAYER_NAMES];
  return normalized.map((name) => ({ id: newId(), name }));
}

function loadLastPlayerNames(): string[] | null {
  if (typeof window === "undefined") return null;
  const parsed = safeJsonParse<PlayersTemplateV1>(localStorage.getItem(LAST_PLAYERS_KEY));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.names)) return null;
  if (parsed.names.length === 0) return null;
  // Keep blanks too, but require at least 1 entry to be meaningful
  return parsed.names.map((n) => (typeof n === "string" ? n : ""));
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

function loadKnownSessions(): KnownSession[] {
  const parsed = safeJsonParse<KnownSession[]>(
    localStorage.getItem(KNOWN_SESSIONS_KEY)
  );
  if (!parsed) return [];
  return parsed
    .filter((s) => Boolean(s?.id) && Boolean(s?.token))
    .map((s) => ({ ...s, currency: CURRENCY }));
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

function generateSessionTokenHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);

  const maybeMessage = (err as { message?: unknown } | null)?.message;
  if (typeof maybeMessage === "string") return new Error(maybeMessage);

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

export default function Home() {
  // Ensures server + first client render match (prevents hydration mismatch),
  // while still letting us update after hydration.
  const [isHydrated, setIsHydrated] = React.useState(false);
  React.useEffect(() => setIsHydrated(true), []);

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionToken, setSessionToken] = React.useState<string | null>(null);

  const [view, setView] = React.useState<"setup" | "game" | "cashout" | "settle">(
    "setup"
  );

  const [sessionName, setSessionName] = React.useState("");

  // IMPORTANT: keep initial render deterministic (no localStorage).
  // Also avoid passing [] here (which will fallback), so it's obvious it's the default.
  const [players, setPlayers] = React.useState<Player[]>(() =>
    buildPlayersFromNames([...DEFAULT_PLAYER_NAMES])
  );

  const [buyIns, setBuyIns] = React.useState<BuyIn[]>([]);
  const [quickPlayerId, setQuickPlayerId] = React.useState<string>("");
  const [quickAmount, setQuickAmount] = React.useState<string>(DEFAULT_BUY_IN);
  const [quickNote, setQuickNote] = React.useState<string>("");

  const [amountDraftByPlayerId, setAmountDraftByPlayerId] = React.useState<
    Record<string, string>
  >({});

  const [cashOutDraftByPlayerId, setCashOutDraftByPlayerId] = React.useState<
    Record<string, string>
  >({});

  const [isFinalized, setIsFinalized] = React.useState(false);
  const [isSettled, setIsSettled] = React.useState(false);

  // IMPORTANT: must be defined BEFORE any hooks/callbacks that reference it,
  // otherwise you'll get: "ReferenceError: Cannot access 'isLocked' before initialization"
  const isLocked = isFinalized || isSettled;

  const [isStarting, setIsStarting] = React.useState(false);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [shareStatus, setShareStatus] = React.useState<"idle" | "copied" | "failed">(
    "idle"
  );

  const [knownSessions, setKnownSessions] = React.useState<KnownSession[]>([]);
  const [loadSessionError, setLoadSessionError] = React.useState<string | null>(
    null
  );

  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [isRecentSessionsOpen, setIsRecentSessionsOpen] = React.useState(false);
  const [editingPlayerId, setEditingPlayerId] = React.useState<string | null>(null);

  // Mobile (Buy-ins) sheets
  const [isAddBuyInOpen, setIsAddBuyInOpen] = React.useState(false);
  const [buyInSheetPlayerId, setBuyInSheetPlayerId] = React.useState<string>("");
  const [buyInSheetAmount, setBuyInSheetAmount] = React.useState<string>(DEFAULT_BUY_IN);
  const [buyInSheetNote, setBuyInSheetNote] = React.useState<string>("");
  const [playerDetailsId, setPlayerDetailsId] = React.useState<string | null>(null);
  const [playerDetailsAmount, setPlayerDetailsAmount] = React.useState<string>(DEFAULT_BUY_IN);

  React.useEffect(() => {
    if (view !== "game") {
      setIsAddBuyInOpen(false);
      setPlayerDetailsId(null);
    }
  }, [view]);

  function openAddBuyInSheet(prefPlayerId?: string) {
    const firstNamed = players.find((p) => p.name.trim());
    const nextPlayerId = prefPlayerId ?? buyInSheetPlayerId ?? firstNamed?.id ?? "";
    setBuyInSheetPlayerId(nextPlayerId);
    setBuyInSheetAmount(DEFAULT_BUY_IN);
    setBuyInSheetNote("");
    setIsAddBuyInOpen(true);
  }

  const playerDetails = React.useMemo(() => {
    if (!playerDetailsId) return null;
    return players.find((p) => p.id === playerDetailsId) ?? null;
  }, [playerDetailsId, players]);

  function resetToNewGame() {
    debug("[New Game] Reset to setup");

    setView("setup");
    setSessionId(null);
    setSessionToken(null);
    setSessionName("");

    // keep last used names (functional update avoids relying on outer `players`)
    setPlayers((prev) => buildPlayersFromNames(prev.map((p) => p.name)));

    setBuyIns([]);
    setQuickPlayerId("");
    setQuickAmount(DEFAULT_BUY_IN);
    setQuickNote("");
    setAmountDraftByPlayerId({});
    setCashOutDraftByPlayerId({});
    setIsFinalized(false);
    setIsSettled(false);

    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  function removePlayer(playerId: string) {
    if (isLocked) return;

    setPlayers((prev) => prev.filter((x) => x.id !== playerId));
    setBuyIns((prev) => prev.filter((b) => b.playerId !== playerId));
    setAmountDraftByPlayerId((prev) => {
      const copy = { ...prev };
      delete copy[playerId];
      return copy;
    });
    setCashOutDraftByPlayerId((prev) => {
      const copy = { ...prev };
      delete copy[playerId];
      return copy;
    });
    if (quickPlayerId === playerId) setQuickPlayerId("");
  }

  const editingPlayer =
    editingPlayerId ? players.find((p) => p.id === editingPlayerId) ?? null : null;

  const editingPlayerIndex = editingPlayerId
    ? players.findIndex((p) => p.id === editingPlayerId)
    : -1;

  const playersCountForPreview = isHydrated ? players.length : DEFAULT_PLAYER_NAMES.length;

  // Remember last-used player names (for "New Game")
  React.useEffect(() => {
    try {
      const payload: PlayersTemplateV1 = { version: 1, names: players.map((p) => p.name) };
      localStorage.setItem(LAST_PLAYERS_KEY, JSON.stringify(payload));
      debug("[Save last player names] Saved last player names", { payload });
    } catch {
      // ignore
    }
  }, [players]);

  // Load known sessions on mount
  React.useEffect(() => {
    setKnownSessions(loadKnownSessions());
  }, []);

  // Persist known sessions whenever they change
  React.useEffect(() => {
    localStorage.setItem(KNOWN_SESSIONS_KEY, JSON.stringify(knownSessions));
  }, [knownSessions]);

  const upsertKnownSession = React.useCallback((s: KnownSession) => {
    setKnownSessions((prev) => {
      const next = prev.filter((x) => x.id !== s.id);
      next.unshift(s);
      return next.slice(0, 25);
    });
    debug("[upsertKnownSession] Added/updated known session", { session: s });
  }, []);

  const removeKnownSession = React.useCallback((id: string) => {
    setKnownSessions((prev) => prev.filter((x) => x.id !== id));
    debug("[removeKnownSession] Removed known session", { id });
  }, []);

  const viewLabel =
    view === "setup"
      ? "Setup"
      : view === "game"
        ? "Buy-ins"
        : view === "cashout"
          ? "Cash-outs"
          : "Settlement";

  const syncLabel = isSyncing ? "Syncing…" : "Saved";
  const lockLabel = isSettled ? "Settled" : isFinalized ? "Finalized" : null;

  async function copySessionId() {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch {
      // ignore
    }
  }

  function mobileBack() {
    if (view === "settle") return setView("cashout");
    if (view === "cashout") return setView("game");
    if (view === "game") return setView("setup");
    resetToNewGame();
  }

  function mobilePrimaryAction() {
    if (view === "setup") return; // handled inline (async)
    if (view === "game") return setView("cashout");
    if (view === "cashout") return setView("settle");

    // settle
    if (!isFinalized) {
      if (totalNetCents !== 0) {
        const ok = window.confirm("Totals don't reconcile to $0. Finalize anyway?");
        if (!ok) return;
      }
      setIsFinalized(true);
      return;
    }

    if (!isSettled) setIsSettled(true);
  }

  async function openSessionByIdAndToken(opts: {
    id: string;
    token: string;
    targetView: "game" | "cashout" | "settle";
  }) {
    setLoadSessionError(null);

    try {
      const client = createClient({ sessionToken: opts.token });
      const { data, error } = await client
        .from("poker_sessions")
        .select("state, name, currency, updated_at")
        .eq("id", opts.id)
        .maybeSingle();

      debug("[openSessionByIdAndToken] Fetched session", {
        id: opts.id,
        hasToken: Boolean(opts.token),
        error,
        hasData: Boolean(data),
      });

      if (error) throw toError(error);
      if (!data)
        throw new Error("Session not found (invalid id/token or missing access_token)");

      const state = data.state as PersistedStateV1;
      if (!state || state.version !== 1) throw new Error("Unsupported session format");

      setSessionId(opts.id);
      setSessionToken(opts.token);

      setSessionName(state.sessionName ?? (data.name ?? ""));
      setPlayers(state.players ?? []);
      setBuyIns(state.buyIns ?? []);
      setCashOutDraftByPlayerId(state.cashOutDraftByPlayerId ?? {});
      setIsFinalized(Boolean(state.isFinalized));
      setIsSettled(Boolean(state.isSettled));

      setView(opts.targetView);

      debug("[openSessionByIdAndToken] Session state set", {
        view: opts.targetView,
        players: state.players,
      });

      upsertKnownSession({
        id: opts.id,
        token: opts.token,
        name: (state.sessionName ?? data.name ?? "").trim() || "Poker Night",
        currency: CURRENCY,
        lastOpenedAtIso: new Date().toISOString(),
      });
    } catch (e) {
      setLoadSessionError(e instanceof Error ? e.message : "Failed to load that session");
    }
  }

  const currencySymbol = CURRENCY_SYMBOL;
  const currency = CURRENCY;

  const canStart = players.filter((p) => p.name.trim().length > 0).length >= 2;

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

  const namedPlayers = React.useMemo(() => players.filter((p) => p.name.trim()), [players]);

  const payments = React.useMemo(() => {
    return computeSettlementPayments(namedPlayers, netByPlayerId);
  }, [namedPlayers, netByPlayerId]);

  const persistableState: PersistedStateV1 = React.useMemo(
    () => ({
      version: 1,
      view,
      sessionName,
      currency: CURRENCY,
      players,
      buyIns,
      cashOutDraftByPlayerId,
      isFinalized,
      isSettled,
    }),
    [buyIns, cashOutDraftByPlayerId, isFinalized, isSettled, players, sessionName, view]
  );

  // Restore from local snapshot on first load (crash recovery).
  // If there's no snapshot, seed the setup screen from the last used player names (localStorage).
  React.useEffect(() => {
    const snap = safeJsonParse<LocalSnapshot>(localStorage.getItem(LOCAL_STORAGE_KEY));
    if (snap && snap.state && snap.state.version === 1) {
      setSessionId(snap.sessionId);
      setSessionToken(snap.sessionToken);

      setView(snap.state.view);
      setSessionName(snap.state.sessionName);
      setPlayers(snap.state.players);
      setBuyIns(snap.state.buyIns);
      setCashOutDraftByPlayerId(snap.state.cashOutDraftByPlayerId);
      setIsFinalized(snap.state.isFinalized);
      setIsSettled(snap.state.isSettled);

      debug("[Restore snapshot] Restored session", {
        sessionId: snap.sessionId,
        hasToken: Boolean(snap.sessionToken),
        view: snap.state.view,
        players: snap.state.players,
      });

      return;
    }

    const lastNames = loadLastPlayerNames();
    if (lastNames && lastNames.length > 0) {
      setPlayers(buildPlayersFromNames(lastNames));
      debug("[Restore last player names] Loaded last player names", { lastNames });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep local snapshot updated (so refresh/crash resumes immediately)
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const snap: LocalSnapshot = { sessionId, sessionToken, state: persistableState };
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(snap));

      if (sessionId && sessionToken) {
        upsertKnownSession({
          id: sessionId,
          token: sessionToken,
          name: sessionName.trim() || "Poker Night",
          currency: CURRENCY,
          lastOpenedAtIso: new Date().toISOString(),
        });
      }
    }, 250);

    return () => window.clearTimeout(t);
  }, [persistableState, sessionId, sessionToken, sessionName, upsertKnownSession]);

  // Background sync to Supabase (debounced) — requires BOTH id + token
  React.useEffect(() => {
    if (!sessionId || !sessionToken) return;

    const t = window.setTimeout(async () => {
      setIsSyncing(true);
      try {
        const client = createClient({ sessionToken });
        await client
          .from("poker_sessions")
          .update({
            name: sessionName.trim() ? sessionName.trim() : null,
            currency: CURRENCY,
            state: persistableState,
          })
          .eq("id", sessionId);
      } finally {
        setIsSyncing(false);
      }
    }, 900);

    return () => window.clearTimeout(t);
  }, [persistableState, sessionId, sessionName, sessionToken]);

  // Fetch latest from Supabase once if we have id + token
  React.useEffect(() => {
    if (!sessionId || !sessionToken) return;

    let cancelled = false;

    (async () => {
      try {
        const client = createClient({ sessionToken });
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
        const client = createClient({ sessionToken: t });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureSessionRow(): Promise<{ id: string; token: string }> {
    if (sessionId && sessionToken) return { id: sessionId, token: sessionToken };

    const token = sessionToken ?? generateSessionTokenHex(16);
    const id = crypto.randomUUID(); // we generate the id so we don't need RETURNING

    const client = createClient({ sessionToken: token });

    // `returning` is not a valid option in supabase-js v2 typings.
    const { error } = await client.from("poker_sessions").insert({
      id,
      access_token: token,
      name: sessionName || null,
      currency: CURRENCY,
      state: persistableState,
    });

    if (error) throw toError(error);

    setSessionId(id);
    setSessionToken(token);

    upsertKnownSession({
      id,
      token,
      name: sessionName.trim() || "Poker Night",
      currency: CURRENCY,
      lastOpenedAtIso: new Date().toISOString(),
    });

    return { id, token };
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

      <div className="relative mx-auto max-w-5xl px-5 py-10 md:py-14 pb-28 md:pb-14">
        {/* Mobile compact top bar */}
        <div className="md:hidden sticky top-0 z-30 -mx-5 mb-6 border-b border-white/10 bg-neutral-950/70 px-5 py-3 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-50">
                {sessionTitle}
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-400">
                {viewLabel} • {syncLabel}
                {lockLabel ? ` • ${lockLabel}` : ""}
              </div>
            </div>

            <div className="relative">
              <button
                type="button"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 hover:bg-white/10"
                onClick={() => setIsMobileMenuOpen((v) => !v)}
                aria-expanded={isMobileMenuOpen}
                aria-haspopup="menu"
              >
                ⋯
              </button>

              {isMobileMenuOpen ? (
                <div className="fixed inset-0 z-40" onClick={() => setIsMobileMenuOpen(false)}>
                  <div
                    className="absolute right-5 top-14 w-56 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/95 shadow-2xl shadow-black/40 backdrop-blur"
                    onClick={(e) => e.stopPropagation()}
                    role="menu"
                  >
                    <button
                      type="button"
                      className="w-full px-4 py-3 text-left text-sm text-neutral-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!sessionId || !sessionToken}
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        void copyShareLink();
                      }}
                      role="menuitem"
                    >
                      Copy share link
                    </button>

                    <button
                      type="button"
                      className="w-full px-4 py-3 text-left text-sm text-neutral-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!sessionId}
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        void copySessionId();
                      }}
                      role="menuitem"
                    >
                      Copy session id
                    </button>

                    <button
                      type="button"
                      className="w-full px-4 py-3 text-left text-sm text-neutral-100 hover:bg-white/10"
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        setIsRecentSessionsOpen(true);
                      }}
                      role="menuitem"
                    >
                      Recent sessions
                    </button>

                    <button
                      type="button"
                      className="w-full px-4 py-3 text-left text-sm text-rose-200 hover:bg-rose-500/10"
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        resetToNewGame();
                      }}
                      role="menuitem"
                    >
                      New game
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Desktop header (unchanged UI, just hidden on mobile) */}
        <header className="hidden md:flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
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
              Silberlicht Poker Tally App
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-neutral-300 md:text-base">
              {view === "setup"
                ? "Create a session, and add players. (Buy-ins and results come next.)"
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
              onClick={resetToNewGame}
            >
              New Game
            </button>

            {view === "setup" ? (
              <button
                type="button"
                disabled={!canStart || isStarting}
                className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                title={canStart ? "Start game" : "Add at least 2 players to continue"}
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

        {/* subtle sync indicator + share (desktop only now) */}
        <div className="hidden md:flex mt-3 flex-wrap items-center gap-2 text-xs text-neutral-500">
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

        {/* Mobile recent sessions sheet */}
        {isRecentSessionsOpen ? (
          <div className="fixed inset-0 z-50 md:hidden" onClick={() => setIsRecentSessionsOpen(false)}>
            <div className="absolute inset-0 bg-black/60" />
            <div
              className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-auto rounded-t-3xl border-t border-white/10 bg-neutral-950/95 p-5 backdrop-blur"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-neutral-50">Recent sessions</div>
                  <div className="mt-1 text-sm text-neutral-400">Saved on this device.</div>
                </div>
                <button
                  type="button"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10"
                  onClick={() => setIsRecentSessionsOpen(false)}
                >
                  Close
                </button>
              </div>

              {loadSessionError ? (
                <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
                  {loadSessionError}
                </div>
              ) : null}

              <div className="mt-4 space-y-3">
                {knownSessions.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 p-4 text-sm text-neutral-400">
                    No recent sessions yet.
                  </div>
                ) : (
                  knownSessions.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-neutral-100">
                          {s.name}
                        </div>
                        <div className="mt-1 text-xs text-neutral-400">
                          {currencySymbol} • {s.id.slice(0, 8)}… •{" "}
                          {new Date(s.lastOpenedAtIso).toLocaleString()}
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-white/15"
                          onClick={() => {
                            setIsRecentSessionsOpen(false);
                            void openSessionByIdAndToken({
                              id: s.id,
                              token: s.token,
                              targetView: "cashout",
                            });
                          }}
                        >
                          Open cash-outs
                        </button>

                        <button
                          type="button"
                          className="rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-white/15"
                          onClick={() => {
                            const url = new URL(window.location.href);
                            url.searchParams.set("s", s.id);
                            url.searchParams.set("t", s.token);
                            void navigator.clipboard.writeText(url.toString()).catch(() => {});
                          }}
                        >
                          Copy link
                        </button>

                        <button
                          type="button"
                          className="col-span-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-200 hover:bg-white/10"
                          onClick={() => removeKnownSession(s.id)}
                        >
                          Remove from this device
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* Mobile edit player sheet */}
        {editingPlayer ? (
          <div className="fixed inset-0 z-50 md:hidden" onClick={() => setEditingPlayerId(null)}>
            <div className="absolute inset-0 bg-black/60" />
            <div
              className="absolute bottom-0 left-0 right-0 max-h-[80vh] overflow-auto rounded-t-3xl border-t border-white/10 bg-neutral-950/95 p-5 backdrop-blur"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-neutral-50">Edit player</div>
                  <div className="mt-1 text-sm text-neutral-400">
                    Player {editingPlayerIndex >= 0 ? editingPlayerIndex + 1 : "—"}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10"
                  onClick={() => setEditingPlayerId(null)}
                >
                  Close
                </button>
              </div>

              <div className="mt-4 space-y-3">
                <label className="block space-y-2">
                  <span className="text-xs text-neutral-300">Name</span>
                  <input
                    value={editingPlayer.name}
                    disabled={isLocked}
                    onChange={(e) =>
                      setPlayers((prev) =>
                        prev.map((x) =>
                          x.id === editingPlayer.id ? { ...x, name: e.target.value } : x
                        )
                      )
                    }
                    placeholder="e.g. Taylor"
                    className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </label>

                <button
                  type="button"
                  className="w-full rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-100 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={isLocked || players.length <= 1}
                  onClick={() => {
                    removePlayer(editingPlayer.id);
                    setEditingPlayerId(null);
                  }}
                >
                  Remove player
                </button>

                {isLocked ? (
                  <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                    This session is {isSettled ? "settled" : "finalized"}. Editing is locked.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {view === "setup" ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            {/* Session card */}
            <section className="lg:col-span-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <h2 className="text-base font-semibold">Session</h2>
                <p className="mt-1 text-sm text-neutral-300">Give it a name (optional).</p>

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

                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 p-4">
                    <div className="text-xs text-neutral-400">Preview</div>
                    <div className="mt-1 text-sm text-neutral-100">
                      <span className="font-semibold">{sessionName.trim() || "Poker Night"}</span> •{" "}
                      {playersCountForPreview} player{playersCountForPreview === 1 ? "" : "s"} •{" "}
                      {currencySymbol}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Players card (desktop unchanged) */}
            <section className="hidden md:block lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Players</h2>
                    <p className="mt-1 text-sm text-neutral-300">Add/remove players anytime.</p>
                  </div>

                  <button
                    type="button"
                    className="w-full rounded-xl bg-white/10 px-3 py-2 text-sm text-neutral-100 hover:bg-white/15 sm:w-auto"
                    onClick={() => {
                      setPlayers((prev) => [{ id: newId(), name: "" }, ...prev]);
                      debug("[Add player] Added new player to top");
                    }}
                    disabled={isLocked}
                    title={isLocked ? "Session is finalized/settled" : undefined}
                  >
                    + Add player
                  </button>
                </div>

                <div className="mt-5 space-y-3">
                  {players.map((p, idx) => {
                    const label = p.name.trim() ? p.name.trim() : `Player ${idx + 1}`;
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
                              <div className="text-xs text-neutral-400">Player {idx + 1}</div>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                            disabled={players.length <= 1 || isLocked}
                            title={isLocked ? "Session is finalized/settled" : undefined}
                            onClick={() => {
                              if (isLocked) return;
                              setPlayers((prev) => prev.filter((x) => x.id !== p.id));
                              setBuyIns((prev) => prev.filter((b) => b.playerId !== p.id));
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
                                    x.id === p.id ? { ...x, name: e.target.value } : x
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
                    <span className="font-semibold">{isSettled ? "settled" : "finalized"}</span>.
                    Editing players is disabled.
                  </div>
                ) : !canStart ? (
                  <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Add at least <span className="font-semibold">2 players</span> with names to
                    start tracking buy-ins.
                  </div>
                ) : null}
              </div>
            </section>

            {/* Players card (mobile compact) */}
            <section className="md:hidden lg:col-span-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">Players</h2>
                    <p className="mt-1 text-sm text-neutral-300">Tap a player to edit.</p>
                  </div>

                  <button
                    type="button"
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm text-neutral-100 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      if (isLocked) return;
                      setPlayers((prev) => [...prev, { id: newId(), name: "" }]);
                    }}
                    disabled={isLocked}
                    title={isLocked ? "Session is finalized/settled" : undefined}
                  >
                    + Add
                  </button>
                </div>

                <div className="mt-4 overflow-hidden rounded-2xl border border-white/10">
                  {players.map((p, idx) => {
                    const label = p.name.trim() ? p.name.trim() : `Player ${idx + 1}`;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 border-b border-white/10 bg-neutral-950/30 px-4 py-3 text-left last:border-b-0"
                        onClick={() => setEditingPlayerId(p.id)}
                        disabled={isLocked}
                        title={isLocked ? "Session is finalized/settled" : "Edit player"}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5">
                            <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-neutral-100">
                              {initials(p.name)}
                            </div>
                          </div>

                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-neutral-100">
                              {label}
                            </div>
                            <div className="text-xs text-neutral-500">Player {idx + 1}</div>
                          </div>
                        </div>

                        <div className="text-sm text-neutral-400">›</div>
                      </button>
                    );
                  })}
                </div>

                {isLocked ? (
                  <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    This session is{" "}
                    <span className="font-semibold">{isSettled ? "settled" : "finalized"}</span>.
                    Editing players is disabled.
                  </div>
                ) : !canStart ? (
                  <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                    Add at least <span className="font-semibold">2 players</span> with names to
                    start tracking buy-ins.
                  </div>
                ) : null}
              </div>
            </section>

            {/* Recent sessions (desktop unchanged) */}
            <section className="hidden md:block lg:col-span-5">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold">Recent sessions</h2>
                    <p className="mt-1 text-sm text-neutral-300">
                      Saved on this device. Open directly to cash-outs.
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2 text-right">
                    <div className="text-[11px] text-neutral-400">Count</div>
                    <div className="text-sm font-semibold text-neutral-50">
                      {knownSessions.length}
                    </div>
                  </div>
                </div>

                {loadSessionError ? (
                  <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
                    {loadSessionError}
                  </div>
                ) : null}

                <div className="mt-4 space-y-3">
                  {knownSessions.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-neutral-950/30 p-4 text-sm text-neutral-400">
                      No recent sessions yet. Start a game to create one.
                    </div>
                  ) : (
                    knownSessions.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-neutral-100">
                              {s.name}
                            </div>
                            <div className="mt-1 text-xs text-neutral-400">
                              {currencySymbol} • {s.id.slice(0, 8)}… •{" "}
                              {new Date(s.lastOpenedAtIso).toLocaleString()}
                            </div>
                          </div>

                          <button
                            type="button"
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-200 hover:bg-white/10"
                            onClick={() => removeKnownSession(s.id)}
                            title="Remove from this device"
                          >
                            Remove
                          </button>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            className="rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-white/15"
                            onClick={() =>
                              void openSessionByIdAndToken({
                                id: s.id,
                                token: s.token,
                                targetView: "cashout",
                              })
                            }
                          >
                            Open cash-outs
                          </button>

                          <button
                            type="button"
                            className="rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-white/15"
                            onClick={() => {
                              const url = new URL(window.location.href);
                              url.searchParams.set("s", s.id);
                              url.searchParams.set("t", s.token);
                              void navigator.clipboard.writeText(url.toString()).catch(() => {});
                            }}
                          >
                            Copy link
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            {/* Recent sessions (mobile compact: open sheet) */}
            <section className="md:hidden lg:col-span-5">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-neutral-50">Recent sessions</div>
                    <div className="mt-1 text-sm text-neutral-300">
                      Saved on this device ({knownSessions.length})
                    </div>
                  </div>

                  <button
                    type="button"
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm text-neutral-100 hover:bg-white/15"
                    onClick={() => setIsRecentSessionsOpen(true)}
                  >
                    Open
                  </button>
                </div>

                {knownSessions.length > 0 ? (
                  <div className="mt-4 rounded-xl border border-white/10 bg-neutral-950/30 p-3 text-xs text-neutral-400">
                    Tip: You can also open this from the <span className="text-neutral-200">⋯</span>{" "}
                    menu.
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-white/10 bg-neutral-950/30 p-4 text-sm text-neutral-400">
                    No recent sessions yet. Start a game to create one.
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : view === "game" ? (
          <>
            {/* Mobile compact buy-ins (list density mode) */}
            <div className="mt-6 md:hidden space-y-4">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl shadow-black/20 backdrop-blur">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-neutral-50">
                      {sessionTitle}
                    </div>
                    <div className="mt-1 text-xs text-neutral-400">
                      Table total:{" "}
                      <span className="font-medium text-neutral-200">
                        {formatMoney(tableTotalCents, currency)}
                      </span>{" "}
                      • Entries:{" "}
                      <span className="font-medium text-neutral-200">{buyIns.length}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="rounded-xl bg-white/10 px-3 py-2 text-sm text-neutral-100 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={isLocked || namedPlayers.length === 0}
                    onClick={() => openAddBuyInSheet(quickPlayerId || namedPlayers[0]?.id)}
                    title={isLocked ? "Locked" : "Add buy-in"}
                  >
                    + Buy-in
                  </button>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10">
                {namedPlayers.map((p) => {
                  const total = totalsByPlayerId[p.id] ?? 0;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 border-b border-white/10 bg-neutral-950/30 px-4 py-3 text-left last:border-b-0"
                      onClick={() => {
                        setPlayerDetailsId(p.id);
                        setPlayerDetailsAmount(DEFAULT_BUY_IN);
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5">
                          <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-neutral-100">
                            {initials(p.name)}
                          </div>
                        </div>

                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-neutral-100">
                            {p.name.trim()}
                          </div>
                          <div className="text-xs text-neutral-500">
                            Buy-ins:{" "}
                            <span className="text-neutral-300">
                              {formatMoney(total, currency)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 text-sm text-neutral-400">›</div>
                    </button>
                  );
                })}
              </div>

              {isLocked ? (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                  This session is{" "}
                  <span className="font-semibold">{isSettled ? "settled" : "finalized"}</span>.
                  Buy-ins are locked.
                </div>
              ) : null}
            </div>

            {/* Desktop buy-ins (unchanged) */}
            <div className="hidden md:block">
              <div className="mt-8 grid gap-6 lg:grid-cols-5">
                {/* Buy-in quick entry + table totals */}
                <section className="lg:col-span-2">
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-xl shadow-black/20 backdrop-blur">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-base font-semibold">{sessionTitle}</h2>
                        <p className="mt-1 text-sm text-neutral-300">
                          Currency:{" "}
                          <span className="font-medium text-neutral-100">{currencySymbol}</span>
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
                            placeholder={DEFAULT_BUY_IN}
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
                          disabled={isLocked || !quickPlayerId || !parseAmountToCents(quickAmount)}
                          onClick={() => {
                            if (isLocked) return;
                            const cents = parseAmountToCents(quickAmount);
                            if (!quickPlayerId || !cents) return;
                            addBuyIn(quickPlayerId, cents, quickNote);
                            setQuickAmount(DEFAULT_BUY_IN);
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
                        <div className="text-sm font-semibold text-neutral-50">{buyIns.length}</div>
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
                                        placeholder={DEFAULT_BUY_IN}
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
                                        setAmountDraftByPlayerId((prev) => ({ ...prev, [p.id]: "" }));
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
            </div>

            {/* Mobile: Add buy-in sheet */}
            {isAddBuyInOpen ? (
              <div className="fixed inset-0 z-50 md:hidden" onClick={() => setIsAddBuyInOpen(false)}>
                <div className="absolute inset-0 bg-black/60" />
                <div
                  className="absolute bottom-0 left-0 right-0 max-h-[85vh] overflow-auto rounded-t-3xl border-t border-white/10 bg-neutral-950/95 p-5 backdrop-blur"
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-neutral-50">Add buy-in</div>
                      <div className="mt-1 text-sm text-neutral-400">
                        Table total: {formatMoney(tableTotalCents, currency)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10"
                      onClick={() => setIsAddBuyInOpen(false)}
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-4 space-y-3">
                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">Player</span>
                      <select
                        value={buyInSheetPlayerId}
                        onChange={(e) => setBuyInSheetPlayerId(e.target.value)}
                        className="w-full appearance-none rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      >
                        <option value="" disabled>
                          Select player…
                        </option>
                        {namedPlayers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name.trim()}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">Amount ({currencySymbol})</span>
                      <input
                        inputMode="decimal"
                        value={buyInSheetAmount}
                        onChange={(e) => setBuyInSheetAmount(e.target.value)}
                        placeholder={DEFAULT_BUY_IN}
                        className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      />
                    </label>

                    <label className="block space-y-2">
                      <span className="text-xs text-neutral-300">Note (optional)</span>
                      <input
                        value={buyInSheetNote}
                        onChange={(e) => setBuyInSheetNote(e.target.value)}
                        placeholder="Rebuy / add-on / etc."
                        className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                      />
                    </label>

                    <button
                      type="button"
                      className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={
                        isLocked || !buyInSheetPlayerId || !parseAmountToCents(buyInSheetAmount)
                      }
                      onClick={() => {
                        if (isLocked) return;
                        const cents = parseAmountToCents(buyInSheetAmount);
                        if (!cents || !buyInSheetPlayerId) return;

                        addBuyIn(buyInSheetPlayerId, cents, buyInSheetNote);
                        setBuyInSheetAmount(DEFAULT_BUY_IN);
                        setBuyInSheetNote("");
                        setIsAddBuyInOpen(false);
                      }}
                    >
                      Add buy-in
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Mobile: Player details sheet (quick add + recent entries) */}
            {playerDetails ? (
              <div
                className="fixed inset-0 z-50 md:hidden"
                onClick={() => setPlayerDetailsId(null)}
              >
                <div className="absolute inset-0 bg-black/60" />
                <div
                  className="absolute bottom-0 left-0 right-0 max-h-[85vh] overflow-auto rounded-t-3xl border-t border-white/10 bg-neutral-950/95 p-5 backdrop-blur"
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-neutral-50">
                        {playerDetails.name.trim()}
                      </div>
                      <div className="mt-1 text-sm text-neutral-400">
                        Total buy-ins:{" "}
                        {formatMoney(totalsByPlayerId[playerDetails.id] ?? 0, currency)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 hover:bg-white/10"
                      onClick={() => setPlayerDetailsId(null)}
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div className="flex items-end gap-2">
                      <label className="block grow space-y-2">
                        <span className="text-xs text-neutral-300">
                          Quick add ({currencySymbol})
                        </span>
                        <input
                          inputMode="decimal"
                          value={playerDetailsAmount}
                          onChange={(e) => setPlayerDetailsAmount(e.target.value)}
                          placeholder={DEFAULT_BUY_IN}
                          className="w-full rounded-xl border border-white/10 bg-neutral-950/40 px-3 py-2 text-sm text-neutral-50 placeholder:text-neutral-500 outline-none focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/20"
                        />
                      </label>

                      <button
                        type="button"
                        className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={isLocked || !parseAmountToCents(playerDetailsAmount)}
                        onClick={() => {
                          if (isLocked) return;
                          const cents = parseAmountToCents(playerDetailsAmount);
                          if (!cents) return;
                          addBuyIn(playerDetails.id, cents);
                          setPlayerDetailsAmount(DEFAULT_BUY_IN);
                        }}
                      >
                        Add
                      </button>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-neutral-950/30 p-4">
                      <div className="text-sm font-semibold text-neutral-100">Recent</div>

                      <div className="mt-3 space-y-2">
                        {buyIns
                          .filter((b) => b.playerId === playerDetails.id)
                          .slice()
                          .reverse()
                          .slice(0, 8).length === 0 ? (
                          <div className="text-sm text-neutral-400">No buy-ins yet.</div>
                        ) : (
                          buyIns
                            .filter((b) => b.playerId === playerDetails.id)
                            .slice()
                            .reverse()
                            .slice(0, 8)
                            .map((b) => (
                              <div
                                key={b.id}
                                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-neutral-950/30 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-neutral-100">
                                    {formatMoney(b.amountCents, currency)}
                                  </div>
                                  <div className="truncate text-xs text-neutral-500">
                                    {new Date(b.createdAtIso).toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                    {b.note ? ` • ${b.note}` : ""}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-white/10 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                                  disabled={isLocked}
                                  title={isLocked ? "Locked" : "Remove"}
                                  onClick={() => removeBuyIn(b.id)}
                                >
                                  ×
                                </button>
                              </div>
                            ))
                        )}
                      </div>
                    </div>

                    {isLocked ? (
                      <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                        This session is {isSettled ? "settled" : "finalized"}. Buy-ins are locked.
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </>
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
                      {currencySymbol}
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
                        totalNetCents === 0 ? "text-emerald-100/80" : "text-amber-100/80"
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
                    <span className="font-semibold">{isSettled ? "settled" : "finalized"}</span>.{" "}
                    Cash-outs are locked.
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
                      totalNetCents === 0 ? "text-emerald-100/80" : "text-amber-100/80"
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
                    <div className="text-sm font-semibold text-neutral-50">{payments.length}</div>
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
                          players.find((x) => x.id === pay.fromPlayerId)?.name.trim() ?? "—";
                        const to =
                          players.find((x) => x.id === pay.toPlayerId)?.name.trim() ?? "—";
                        return (
                          <div
                            key={`${pay.fromPlayerId}_${pay.toPlayerId}_${pay.amountCents}`}
                            className="grid grid-cols-12 px-4 py-3 text-sm"
                          >
                            <div className="col-span-5 font-medium text-neutral-100">{from}</div>
                            <div className="col-span-5 font-medium text-neutral-100">{to}</div>
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

        {/* Mobile sticky bottom action bar */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-white/10 bg-neutral-950/80 px-5 py-3 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <button
              type="button"
              className="w-1/2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-neutral-100 hover:bg-white/10"
              onClick={mobileBack}
            >
              {view === "setup" ? "New game" : "Back"}
            </button>

            {view === "setup" ? (
              <button
                type="button"
                disabled={!canStart || isStarting}
                className="w-1/2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
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
            ) : (
              <button
                type="button"
                disabled={view === "settle" && isFinalized && isSettled}
                className="w-1/2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={mobilePrimaryAction}
              >
                {view === "game"
                  ? "Enter cash-outs"
                  : view === "cashout"
                    ? "View settlement"
                    : !isFinalized
                      ? "Finalize"
                      : isSettled
                        ? "Settled"
                        : "Mark settled"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
