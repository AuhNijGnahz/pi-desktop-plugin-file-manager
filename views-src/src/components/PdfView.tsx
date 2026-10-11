import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { T } from "../i18n";
import { createPdfSession } from "../lib/pdf";
import { clampPdfZoom, createDocumentViewer, MAX_PDF_ZOOM, MIN_PDF_ZOOM, type DocumentViewer, type PdfFindState, type PdfSpread } from "../lib/pdfViewer";
import { PdfSidebar, type PdfSidebarTab } from "./PdfSidebar";
import "../styles/pdf.css";

type Props = { src: string; name: string; size: number; locale: "en" | "zh"; t: T };
type PdfError = "failed" | "encrypted" | null;

/** Continuous PDF.js viewer with a document-scoped worker and optional sidebar. */
export function PdfView({ src, name, size, locale, t }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<PdfError>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoom, setZoom] = useState<number | null>(null);
  const [renderedZoom, setRenderedZoom] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [spread, setSpread] = useState<PdfSpread>("single");
  const [sidebar, setSidebar] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<PdfSidebarTab>("thumbnails");
  const [labels, setLabels] = useState<string[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState({ current: 0, total: 0 });
  const [searchState, setSearchState] = useState<PdfFindState | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<DocumentViewer | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const count = pdf?.numPages ?? 0;

  useEffect(() => {
    const scroll = scrollRef.current!;
    const host = pagesRef.current!;
    let cancelled = false;
    let failed = false;
    let session: ReturnType<typeof createPdfSession> | undefined;
    let controller: DocumentViewer | undefined;
    setPdf(null);
    setError(null);
    setReady(false);
    setRendering(true);
    setPage(1);
    setZoom(null);
    setSpread("single");
    setLabels(null);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchCount({ current: 0, total: 0 });
    setSearchState(null);
    const fail = (cause?: { name?: string }) => {
      if (cancelled || failed) return;
      failed = true;
      setError(cause?.name === "PasswordException" ? "encrypted" : "failed");
      setReady(false);
      setPdf(null);
      setRendering(false);
      setSearchOpen(false);
      setSearchQuery("");
      setSearchCount({ current: 0, total: 0 });
      setSearchState(null);
      controller?.destroy();
      controllerRef.current = null;
      void session?.destroy();
    };
    try {
      session = createPdfSession(src, () => fail());
      void session.promise.then((document) => {
        if (cancelled || failed) return;
        setPdf(document);
        controller = createDocumentViewer(scroll, host, document, {
          t: () => tRef.current,
          ready: () => { if (!cancelled && !failed) setReady(true); },
          page: (number) => { if (!cancelled && !failed) setPage(number); },
          scale: (value) => { if (!cancelled && !failed) setRenderedZoom(value); },
          rendering: (busy) => { if (!cancelled && !failed) setRendering(busy); },
          failed: () => fail(),
          find: (update) => {
            if (!cancelled && !failed) {
              setSearchCount(update.matchesCount);
              setSearchState(update.state);
            }
          },
        });
        controllerRef.current = controller;
        void document.getPageLabels().then((value) => {
          if (!cancelled && !failed) {
            setLabels(value);
            controller?.viewer.setPageLabels(value);
          }
        }).catch(() => {}); // Invalid optional labels must not hide readable pages.
      }).catch(fail);
    } catch {
      fail();
    }
    return () => {
      cancelled = true;
      controller?.destroy();
      controllerRef.current = null;
      void session?.destroy();
    };
  }, [src]);

  useEffect(() => setPageDraft(String(page)), [page]);
  useEffect(() => { controllerRef.current?.labelPages(); }, [t]);

  const thumbnailRendered = useCallback((number: number, thumbnailPage: PDFPageProxy) => {
    const controller = controllerRef.current;
    if (controller?.viewer.pdfDocument === pdf) controller.thumbnailRendered(number, thumbnailPage);
  }, [pdf]);

  const goToPage = (number: number) => {
    controllerRef.current?.goToPage(number);
    if ((bodyRef.current?.clientWidth ?? 0) <= 620) setSidebar(false);
  };
  const commitPage = () => {
    const input = Number(pageDraft);
    const next = pageDraft.trim() && Number.isFinite(input) ? Math.min(count, Math.max(1, Math.trunc(input))) : page;
    goToPage(next);
    setPageDraft(String(next));
  };
  const applyZoom = (value: number | null) => {
    setZoom(value);
    controllerRef.current?.setZoom(value);
  };
  const changeZoom = (factor: number) => applyZoom(clampPdfZoom((controllerRef.current?.viewer.currentScale ?? renderedZoom) * factor));
  const disabled = !ready || Boolean(error);
  const pageLabel = labels?.[page - 1];
  const openSearch = () => {
    if (disabled) return;
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const clearSearch = () => {
    controllerRef.current?.closeSearch();
    setSearchCount({ current: 0, total: 0 });
    setSearchState(null);
  };
  const closeSearch = () => {
    clearSearch();
    setSearchOpen(false);
    setSearchQuery("");
  };
  const isTextInput = (target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
  };
  const handleStageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !isTextInput(event.target)) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === "Escape") {
      if (searchOpen) {
        event.preventDefault();
        closeSearch();
      } else {
        setSidebar(false);
      }
    }
  };
  const search = (again = false, previous = false, query = searchQuery) => {
    if (!query.trim()) {
      clearSearch();
      return;
    }
    controllerRef.current?.search(query, again, previous);
  };
  const searchStatus = searchState === "PENDING"
    ? `${t("pdfSearchSearching")}${searchCount.total > 0 ? ` ${t("pdfSearchCount", searchCount)}` : ""}`
    : searchState === "NOT_FOUND"
      ? t("pdfSearchNoMatches")
      : searchCount.total > 0
        ? t("pdfSearchCount", searchCount)
        : null;

  return (
    <div className="pdf-stage" aria-label={t("pdfPreview")} onKeyDown={handleStageKeyDown}>
      <div className="pdf-toolbar" role="toolbar" aria-label={t("pdfPreview")}>
        <div className="pdf-navigation">
          <button type="button" aria-expanded={sidebar} aria-controls="pdf-navigation-sidebar" disabled={disabled} title={t("pdfSidebar")}
            onClick={() => setSidebar((value) => !value)}>{t("pdfSidebar")}</button>
          <button type="button" title={t("prevPage")} aria-label={t("prevPage")} disabled={disabled || page <= 1} onClick={() => goToPage(page - 1)}>‹</button>
          <input type="number" min={1} max={count || 1} step={1} aria-label={t("pdfPage")} title={t("pdfPage")} value={pageDraft} disabled={disabled}
            onChange={(event) => setPageDraft(event.target.value)} onBlur={commitPage}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitPage(); } }} />
          <span className="pdf-page-count">/ {count || "—"}</span>
          <button type="button" title={t("nextPage")} aria-label={t("nextPage")} disabled={disabled || page >= count} onClick={() => goToPage(page + 1)}>›</button>
          {pageLabel && pageLabel !== String(page) ? <span className="pdf-page-label" title={t("pdfPageLabel")}>{pageLabel}</span> : null}
        </div>
        <select className="pdf-layout" aria-label={t("pdfLayout")} title={t("pdfLayout")} disabled={disabled} value={spread}
          onChange={(event) => { const value = event.target.value as PdfSpread; setSpread(value); controllerRef.current?.setSpread(value); }}>
          <option value="single">{t("pdfSinglePage")}</option>
          <option value="double">{t("pdfDoublePage")}</option>
          <option value="cover">{t("pdfCoverPage")}</option>
        </select>
        <div className="pdf-search">
          <button type="button" aria-label={t("pdfSearch")} aria-pressed={searchOpen} title={t("pdfSearch")} disabled={disabled}
            onClick={openSearch}>⌕</button>
          {searchOpen ? <div className="pdf-search-controls">
            <input ref={searchInputRef} type="search" value={searchQuery} aria-label={t("pdfSearch")} placeholder={t("pdfSearchPlaceholder")} disabled={disabled}
              onChange={(event) => {
                const query = event.target.value;
                setSearchQuery(query);
                search(false, false, query);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  search(true, event.shiftKey);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }} />
            <span className="pdf-search-status" role="status" aria-live="polite">{searchStatus}</span>
            <button type="button" aria-label={t("pdfSearchPrevious")} title={t("pdfSearchPrevious")} disabled={disabled || !searchQuery.trim()}
              onClick={() => search(true, true)}>↑</button>
            <button type="button" aria-label={t("pdfSearchNext")} title={t("pdfSearchNext")} disabled={disabled || !searchQuery.trim()}
              onClick={() => search(true)}>↓</button>
            <button type="button" aria-label={t("pdfSearchClose")} title={t("pdfSearchClose")} disabled={disabled} onClick={closeSearch}>×</button>
          </div> : null}
        </div>
        <div className="pdf-zoom">
          <button type="button" title={t("pdfZoomOut")} aria-label={t("pdfZoomOut")} disabled={disabled || renderedZoom <= MIN_PDF_ZOOM} onClick={() => changeZoom(1 / 1.25)}>−</button>
          <span className="pdf-zoom-value">{pdf ? `${Math.round(renderedZoom * 100)}%` : "—"}</span>
          <button type="button" title={t("pdfZoomIn")} aria-label={t("pdfZoomIn")} disabled={disabled || renderedZoom >= MAX_PDF_ZOOM} onClick={() => changeZoom(1.25)}>+</button>
          <button type="button" aria-pressed={zoom === null} disabled={disabled} onClick={() => applyZoom(null)}>{t("pdfFitWidth")}</button>
          <button type="button" aria-pressed={zoom === 1} disabled={disabled} onClick={() => applyZoom(1)}>{t("pdfActual")}</button>
        </div>
      </div>
      <div className="pdf-body" ref={bodyRef}>
        {sidebar && pdf && !error ? <div className="pdf-sidebar-host" id="pdf-navigation-sidebar">
          <PdfSidebar pdf={pdf} name={name} size={size} locale={locale} page={page} labels={labels} tab={sidebarTab} t={t}
            onTab={setSidebarTab} onClose={() => setSidebar(false)} onPage={goToPage} onThumbnailRendered={thumbnailRendered}
            onDestination={async (destination) => {
              await controllerRef.current?.goToDestination(destination);
              if ((bodyRef.current?.clientWidth ?? 0) <= 620) setSidebar(false);
            }} />
        </div> : null}
        <div className="pdf-reader">
          <div className="pdf-scroll" ref={scrollRef} tabIndex={0} aria-label={`${name} — ${t("pdfPreview")}`} aria-busy={!error && (!ready || rendering)}>
            <div className="pdf-document pdfViewer" ref={pagesRef} hidden={Boolean(error)} />
            {error ? <div className="pdf-message" role="alert">{t(error === "encrypted" ? "pdfEncrypted" : "pdfFailed")}</div> : null}
          </div>
          {!error && (!ready || rendering) ? <div className="pdf-status" role="status">{t(pdf ? "pdfRendering" : "pdfLoading")}</div> : null}
        </div>
      </div>
    </div>
  );
}
