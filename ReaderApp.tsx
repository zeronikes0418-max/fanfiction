"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import type { OpenWork, ReaderSettings, WorkMeta } from "@/types";
import { DEFAULT_SETTINGS, FONT_STACKS, LETTER_SPACING, THEMES, themeVars } from "@/lib/themes";
import {
  loadContent,
  loadCurrentId,
  loadIndex,
  loadSettings,
  removeWork,
  saveCurrentId,
  saveSettings,
  saveWork,
  updateProgress,
} from "@/lib/storage";
import {
  chunkArray,
  decodeTextFile,
  escapeRegExp,
  guessTitle,
  makeWorkId,
  normalizeText,
  splitParagraphs,
  stripExt,
} from "@/lib/text";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useReadingStats } from "@/hooks/useReadingStats";
import BarButton from "./BarButton";
import ImportModal from "./ImportModal";
import LibraryView from "./LibraryView";
import SearchBar from "./SearchBar";
import SettingsPanel from "./SettingsPanel";
import StatsWidget from "./StatsWidget";
import TextBody from "./TextBody";

const CHUNK_SIZE = 40;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EMPTY_PREFIX: number[] = [];

// SSR 경고 없이 레이아웃 이펙트를 쓰기 위한 처리
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function getScrollPercent(): number {
  const el = document.documentElement;
  const max = el.scrollHeight - window.innerHeight;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (window.scrollY / max) * 100));
}

const topBtn =
  "flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium text-reader-fg transition-colors hover:bg-reader-hover active:bg-reader-hover";

export default function ReaderApp() {
  /* ---------------- 상태 ---------------- */
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [works, setWorks] = useState<WorkMeta[]>([]);
  const [current, setCurrent] = useState<OpenWork | null>(null);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);

  const [barsVisible, setBarsVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /* ---------------- ref ---------------- */
  const percentRef = useRef(0);
  const startPercentRef = useRef(0);
  const readyRef = useRef(false);
  const restoringRef = useRef(false);
  const currentIdRef = useRef<string | null>(null);
  const openSeqRef = useRef(0);
  const hintShownRef = useRef(false);
  const barsVisibleRef = useRef(false);
  const hoverShownRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  barsVisibleRef.current = barsVisible;

  const theme = THEMES[settings.theme];
  const barsShown = barsVisible || settingsOpen || searchOpen;

  /* ---------------- 독서 통계 ---------------- */
  const {
    seconds,
    charsRead,
    idle,
    reset: resetStats,
    ignoreFor,
    onProgress,
  } = useReadingStats(Boolean(current) && ready, current?.meta.length ?? 0, autoScroll);

  /* ---------------- 공통 유틸 ---------------- */
  const showToast = useCallback((message: string, ms = 2600) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);

  /** 현재 읽은 위치를 LocalStorage에 기록 (복원 중에는 덮어쓰지 않는다) */
  const flushProgress = useCallback(() => {
    const id = currentIdRef.current;
    if (!id || !readyRef.current || restoringRef.current) return;
    updateProgress(id, percentRef.current);
  }, []);

  const beginOpen = useCallback(
    (meta: WorkMeta, content: string) => {
      openSeqRef.current += 1;
      currentIdRef.current = meta.id;
      readyRef.current = false;
      restoringRef.current = false;
      startPercentRef.current = meta.scrollPercent;
      percentRef.current = meta.scrollPercent;

      setProgress(meta.scrollPercent);
      setReady(false);
      setAutoScroll(false);
      setSettingsOpen(false);
      setSearchOpen(false);
      setQuery("");
      setDebouncedQuery("");
      setBarsVisible(false);
      setCurrent({ meta, content, seq: openSeqRef.current });
      resetStats();
      saveCurrentId(meta.id);
      window.scrollTo({ top: 0, behavior: "auto" });
    },
    [resetStats]
  );

  /* ---------------- 최초 로드: 설정 + 목록 + 마지막 작품 자동 열기 ---------------- */
  useEffect(() => {
    setSettings(loadSettings());
    const list = loadIndex();
    setWorks(list);

    const cid = loadCurrentId();
    if (cid) {
      const meta = list.find((w) => w.id === cid);
      const content = meta ? loadContent(cid) : null;
      if (meta && content) beginOpen(meta, content);
    }
    setHydrated(true);
    // 최초 1회만 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 설정 저장 / 테마 적용 ---------------- */
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => saveSettings(settings), 300);
    return () => clearTimeout(t);
  }, [settings, hydrated]);

  useEffect(() => {
    document.documentElement.style.backgroundColor = theme.bg;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = theme.bg;
  }, [theme.bg]);

  const updateSetting = useCallback(
    <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    []
  );

  /** 글자 크기/줄간격 등이 바뀌어도 읽던 위치(%)를 유지 */
  useIsoLayoutEffect(() => {
    if (!current || !ready) return;
    const el = document.documentElement;
    const max = el.scrollHeight - window.innerHeight;
    if (max > 0) window.scrollTo({ top: (percentRef.current / 100) * max, behavior: "auto" });
  }, [settings.fontSize, settings.lineHeight, settings.letterSpacing, settings.fontFamily, settings.sidePadding]);

  /* ---------------- 본문 가공 ---------------- */
  const paragraphs = useMemo(() => (current ? splitParagraphs(current.content) : []), [current]);
  const chunks = useMemo(() => chunkArray(paragraphs, CHUNK_SIZE), [paragraphs]);

  /* ---------------- 파일 / 텍스트 가져오기 ---------------- */
  const importText = useCallback(
    (title: string, rawText: string): boolean => {
      const text = normalizeText(rawText);
      if (!text.trim()) {
        showToast("내용이 비어 있어요.");
        return false;
      }
      const finalTitle = title.trim() || guessTitle(text);
      const id = makeWorkId(finalTitle, text);
      const existing = loadIndex().find((w) => w.id === id);
      const meta: WorkMeta = {
        id,
        title: finalTitle,
        length: text.length,
        scrollPercent: existing?.scrollPercent ?? 0,
        lastReadAt: Date.now(),
      };
      const { stored, list } = saveWork(meta, text);
      setWorks(list);
      if (!stored) {
        showToast("저장 공간이 부족해서 이어보기가 저장되지 않아요. 이번에만 읽을 수 있어요.", 4800);
      }
      beginOpen(meta, text);
      return true;
    },
    [beginOpen, showToast]
  );

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      const isTxt = /\.txt$/i.test(file.name) || file.type === "text/plain";
      if (!isTxt) {
        showToast(".txt 파일만 불러올 수 있어요.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        showToast("파일이 너무 커요. 20MB 이하의 파일을 선택해 주세요.");
        return;
      }
      setBusy("파일을 읽는 중…");
      await new Promise((r) => setTimeout(r, 0)); // 로딩 표시가 먼저 그려지도록 양보
      try {
        const text = await decodeTextFile(file);
        importText(stripExt(file.name), text);
      } catch {
        showToast("파일을 읽지 못했어요. 다른 파일로 다시 시도해 주세요.");
      } finally {
        setBusy(null);
      }
    },
    [importText, showToast]
  );

  const openFromLibrary = useCallback(
    (meta: WorkMeta) => {
      const content = loadContent(meta.id);
      if (!content) {
        setWorks(removeWork(meta.id));
        showToast("저장된 본문을 찾을 수 없어서 목록에서 제거했어요.");
        return;
      }
      updateProgress(meta.id, meta.scrollPercent); // 최근 읽은 순서 갱신
      beginOpen(meta, content);
    },
    [beginOpen, showToast]
  );

  const deleteFromLibrary = useCallback((id: string) => {
    setWorks(removeWork(id));
  }, []);

  const goHome = useCallback(() => {
    flushProgress();
    currentIdRef.current = null;
    readyRef.current = false;
    saveCurrentId(null);
    setAutoScroll(false);
    setSettingsOpen(false);
    setSearchOpen(false);
    setQuery("");
    setDebouncedQuery("");
    setWorks(loadIndex());
    setCurrent(null);
    setReady(false);
  }, [flushProgress]);

  useEffect(() => {
    if (hydrated && !current) window.scrollTo({ top: 0, behavior: "auto" });
  }, [current, hydrated]);

  /* ---------------- 본문 렌더 완료 → 이어보기 위치로 부드럽게 이동 ---------------- */
  const handleReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;

    const pct = startPercentRef.current;
    const shouldRestore = pct > 0.3;
    if (shouldRestore) {
      restoringRef.current = true;
      ignoreFor(2500);
      window.setTimeout(() => {
        restoringRef.current = false;
      }, 1800);
    }
    setReady(true);

    window.requestAnimationFrame(() => {
      if (shouldRestore) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (max > 0) window.scrollTo({ top: (pct / 100) * max, behavior: "smooth" });
      }
      if (!hintShownRef.current) {
        hintShownRef.current = true;
        showToast("화면을 한 번 탭하면 메뉴가 나타나요.", 3200);
      }
    });
  }, [ignoreFor, showToast]);

  /* ---------------- 스크롤: 진행률 + 0.5초 디바운스 저장 ---------------- */
  useEffect(() => {
    if (!current || !ready) return;

    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const measure = () => {
      raf = 0;
      const p = getScrollPercent();
      percentRef.current = p;
      setProgress(p);
      onProgress(p);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flushProgress, 500);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushProgress();
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flushProgress);
    document.addEventListener("visibilitychange", onVisibility);
    if (!restoringRef.current) measure();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", flushProgress);
      document.removeEventListener("visibilitychange", onVisibility);
      if (raf) window.cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      flushProgress();
    };
  }, [current?.seq, ready, flushProgress, onProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 자동 스크롤 ---------------- */
  const handleAutoEnd = useCallback(() => {
    setAutoScroll(false);
    showToast("끝까지 읽었어요 🎉");
  }, [showToast]);

  useAutoScroll(autoScroll && ready, settings.autoScrollSpeed, handleAutoEnd);

  const toggleAutoScroll = useCallback(() => {
    if (autoScroll) {
      setAutoScroll(false);
      return;
    }
    if (getScrollPercent() >= 99.5) {
      showToast("이미 끝까지 읽었어요.");
      return;
    }
    setAutoScroll(true);
  }, [autoScroll, showToast]);

  const changeSpeed = useCallback((delta: number) => {
    setSettings((s) => ({
      ...s,
      autoScrollSpeed: Math.min(10, Math.max(1, s.autoScrollSpeed + delta)),
    }));
  }, []);

  // 자동 스크롤 중에는 툴바를 3.5초 뒤 자동으로 숨겨 본문에 집중
  useEffect(() => {
    if (!autoScroll || !barsVisible || settingsOpen || searchOpen) return;
    const t = setTimeout(() => setBarsVisible(false), 3500);
    return () => clearTimeout(t);
  }, [autoScroll, barsVisible, settingsOpen, searchOpen, settings.autoScrollSpeed]);

  /* ---------------- 검색 ---------------- */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const q = debouncedQuery.trim().length > 0 ? debouncedQuery : "";

  const search = useMemo(() => {
    if (!q) return { prefix: EMPTY_PREFIX, total: 0 };
    const re = new RegExp(escapeRegExp(q), "gi");
    const prefix = new Array<number>(paragraphs.length + 1);
    let sum = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      prefix[i] = sum;
      const m = paragraphs[i].match(re);
      if (m) sum += m.length;
    }
    prefix[paragraphs.length] = sum;
    return { prefix, total: sum };
  }, [paragraphs, q]);

  useEffect(() => {
    setActiveIdx(0);
  }, [q]);

  const safeActive = search.total > 0 ? Math.min(activeIdx, search.total - 1) : -1;

  const goNext = useCallback(() => {
    if (search.total === 0) return;
    setActiveIdx((i) => (Math.min(i, search.total - 1) + 1) % search.total);
  }, [search.total]);

  const goPrev = useCallback(() => {
    if (search.total === 0) return;
    setActiveIdx((i) => (Math.min(i, search.total - 1) - 1 + search.total) % search.total);
  }, [search.total]);

  // 활성 일치 항목으로 스크롤 (하이라이트는 TextBody가 처리)
  useEffect(() => {
    if (safeActive < 0 || !ready) return;
    const id = window.requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`mark[data-match="${safeActive}"]`);
      if (el) {
        ignoreFor(1800);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [safeActive, q, ready, ignoreFor]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    setDebouncedQuery("");
  }, []);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
    } else {
      setSettingsOpen(false);
      setSearchOpen(true);
    }
  }, [searchOpen, closeSearch]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
    } else {
      closeSearch();
      setSettingsOpen(true);
    }
  }, [settingsOpen, closeSearch]);

  /* ---------------- 키보드: Ctrl+F 대체, Esc ---------------- */
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSettingsOpen(false);
        setSearchOpen(true);
        window.setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 30);
        return;
      }
      if (e.key === "Escape" && !importOpen) {
        if (settingsOpen) setSettingsOpen(false);
        else if (searchOpen) closeSearch();
        else if (barsVisible) setBarsVisible(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, importOpen, settingsOpen, searchOpen, barsVisible, closeSearch]);

  /* ---------------- 마우스를 상단에 올리면 툴바 표시 ---------------- */
  useEffect(() => {
    if (!current) return;
    const clearHide = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (e.clientY <= 56) {
        clearHide();
        if (!barsVisibleRef.current) {
          hoverShownRef.current = true;
          setBarsVisible(true);
        }
        return;
      }
      if (hoverShownRef.current && e.clientY > 150 && e.clientY < window.innerHeight - 150) {
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => {
            hoverShownRef.current = false;
            hideTimerRef.current = undefined;
            setBarsVisible(false);
          }, 1200);
        }
        return;
      }
      clearHide();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      clearHide();
    };
  }, [current]);

  /* ---------------- 본문 클릭(터치) → 툴바 토글 ---------------- */
  const onReaderClick = useCallback(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) return; // 텍스트 선택 중에는 무시
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    hoverShownRef.current = false;
    setBarsVisible((v) => !v);
  }, [settingsOpen]);

  /* ---------------- 드래그 앤 드롭 ---------------- */
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.relatedTarget) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    void handleFile(e.dataTransfer.files[0]);
  };

  const pickFile = useCallback(() => fileInputRef.current?.click(), []);

  /* ---------------- 본문 스타일 ---------------- */
  const articleStyle = {
    fontFamily: FONT_STACKS[settings.fontFamily],
    fontSize: `${settings.fontSize}px`,
    lineHeight: settings.lineHeight,
    letterSpacing: LETTER_SPACING[settings.letterSpacing].value,
    wordBreak: "keep-all",
    overflowWrap: "anywhere",
    "--side-pad": `${settings.sidePadding}%`,
  } as CSSProperties;

  const barTransition =
    "transition-[transform,opacity,visibility] duration-300 ease-out";

  /* ---------------- 렌더 ---------------- */
  return (
    <div
      className="min-h-screen bg-reader-bg text-reader-fg"
      style={themeVars(theme)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {!hydrated ? null : !current ? (
        <LibraryView
          works={works}
          onOpen={openFromLibrary}
          onDelete={deleteFromLibrary}
          onPickFile={pickFile}
          onOpenImport={() => setImportOpen(true)}
        />
      ) : (
        <>
          {/* 읽기 진행률 바 (항상 최상단 고정) */}
          <div
            className="fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 h-1 bg-reader-border"
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="읽기 진행률"
          >
            <div
              className="h-full bg-reader-accent transition-[width] duration-150 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* 본문 */}
          <main onClick={onReaderClick} className="min-h-screen">
            <article
              className="reader-article mx-auto w-full max-w-[1600px] px-5 pb-[35vh] pt-20 md:px-[var(--side-pad)]"
              style={articleStyle}
            >
              <h1 className="mb-8 text-[1.35em] font-bold leading-snug">{current.meta.title}</h1>
              <TextBody
                key={`${current.meta.id}:${current.seq}`}
                chunks={chunks}
                chunkSize={CHUNK_SIZE}
                query={q}
                matchPrefix={search.prefix}
                activeIndex={safeActive}
                onReady={handleReady}
              />
              <p className="mt-16 text-center text-sm text-reader-muted">— 끝 —</p>
            </article>
          </main>

          {/* 불러오는 동안 가리는 오버레이 */}
          {!ready && (
            <div className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-reader-bg text-reader-muted">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-reader-border border-t-reader-accent" />
              <p className="text-sm">작품을 불러오는 중…</p>
            </div>
          )}

          {/* 상단 툴바 */}
          <header
            aria-hidden={!barsShown}
            className={`fixed inset-x-0 top-0 z-40 border-b border-reader-border bg-reader-ui shadow-sm backdrop-blur-md ${barTransition} ${
              barsShown ? "visible translate-y-0 opacity-100" : "invisible -translate-y-full opacity-0"
            }`}
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-2">
              <button type="button" onClick={goHome} className={topBtn} aria-label="작품 목록으로">
                <span aria-hidden>←</span>
                <span className="hidden sm:inline">목록</span>
              </button>
              <div className="min-w-0 flex-1 px-2">
                <p className="truncate text-sm font-semibold">{current.meta.title}</p>
                <p className="text-[11px] tabular-nums text-reader-muted">
                  {progress.toFixed(1)}% · {current.meta.length.toLocaleString()}자
                </p>
              </div>
              <button type="button" onClick={pickFile} className={topBtn} aria-label=".txt 파일 열기">
                <span aria-hidden>📂</span>
                <span className="hidden sm:inline">.txt 열기</span>
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className={topBtn}
                aria-label="텍스트 가져오기"
              >
                <span aria-hidden>📋</span>
                <span className="hidden sm:inline">텍스트 가져오기</span>
              </button>
            </div>
          </header>

          {/* 하단 툴바 (모바일 한 손 조작: 하단 밀착 + 큰 터치 영역) */}
          <footer
            aria-hidden={!barsShown}
            className={`fixed inset-x-0 bottom-0 z-40 border-t border-reader-border bg-reader-ui shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur-md ${barTransition} ${
              barsShown ? "visible translate-y-0 opacity-100" : "invisible translate-y-full opacity-0"
            }`}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-1 px-2 py-2">
              <BarButton icon="🔍" label="검색" onClick={toggleSearch} active={searchOpen} />
              <div className="flex items-center gap-1">
                <BarButton
                  icon="−"
                  label="느리게"
                  ariaLabel="자동 스크롤 느리게"
                  onClick={() => changeSpeed(-1)}
                />
                <BarButton
                  icon={autoScroll ? "⏸" : "▶"}
                  label={`자동 스크롤 ${settings.autoScrollSpeed}`}
                  ariaLabel={autoScroll ? "자동 스크롤 정지" : "자동 스크롤 시작"}
                  onClick={toggleAutoScroll}
                  primary={autoScroll}
                  active={autoScroll}
                />
                <BarButton
                  icon="+"
                  label="빠르게"
                  ariaLabel="자동 스크롤 빠르게"
                  onClick={() => changeSpeed(1)}
                />
              </div>
              <BarButton icon="Aa" label="설정" onClick={toggleSettings} active={settingsOpen} />
            </div>
          </footer>

          {searchOpen && (
            <SearchBar
              query={query}
              onQueryChange={setQuery}
              total={search.total}
              position={safeActive + 1}
              onNext={goNext}
              onPrev={goPrev}
              onClose={closeSearch}
              inputRef={searchInputRef}
            />
          )}

          {settingsOpen && (
            <SettingsPanel
              settings={settings}
              onChange={updateSetting}
              onReset={() => setSettings({ ...DEFAULT_SETTINGS, theme: settings.theme })}
              onClose={() => setSettingsOpen(false)}
            />
          )}

          {/* ⏱️ 독서 타이머 & 속도 통계 */}
          {ready && (
            <StatsWidget
              seconds={seconds}
              charsRead={charsRead}
              progress={progress}
              totalChars={current.meta.length}
              idle={idle}
              offsetDown={barsShown}
            />
          )}
        </>
      )}

      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onSubmit={(title, text) => void importText(title, text)} />
      )}

      {busy && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/40">
          <div className="flex items-center gap-3 rounded-2xl border border-reader-border bg-reader-bg px-5 py-4 text-sm shadow-xl">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-reader-border border-t-reader-accent" />
            {busy}
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-[65] flex items-center justify-center rounded-3xl border-4 border-dashed border-reader-accent bg-reader-ui text-lg font-bold backdrop-blur-sm">
          여기에 .txt 파일을 놓으세요
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+96px)] left-1/2 z-[70] max-w-[90vw] -translate-x-1/2 animate-fade-in rounded-full bg-reader-fg px-4 py-2 text-center text-sm text-reader-bg shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
