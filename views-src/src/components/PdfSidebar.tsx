import { useEffect, useRef, useState } from "react";
import { AnnotationMode, PDFDateString, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { CopyKey, T } from "../i18n";
import { formatSize } from "../lib/format";

export type PdfSidebarTab = "thumbnails" | "outline" | "info";
type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>;
type Metadata = Awaited<ReturnType<PDFDocumentProxy["getMetadata"]>>;
type Props = {
  pdf: PDFDocumentProxy;
  name: string;
  size: number;
  locale: "en" | "zh";
  page: number;
  labels: string[] | null;
  tab: PdfSidebarTab;
  t: T;
  onTab: (tab: PdfSidebarTab) => void;
  onClose: () => void;
  onPage: (page: number) => void;
  onDestination: (destination: string | unknown[]) => Promise<void>;
  onThumbnailRendered: (number: number, page: PDFPageProxy) => void;
};
const TABS: { id: PdfSidebarTab; key: CopyKey }[] = [
  { id: "thumbnails", key: "pdfThumbnails" },
  { id: "outline", key: "pdfOutline" },
  { id: "info", key: "pdfInfo" },
];

export function PdfSidebar({ pdf, name, size, locale, page, labels, tab, t, onTab, onClose, onPage, onDestination, onThumbnailRendered }: Props) {
  const [outline, setOutline] = useState<Outline | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [outlineFailed, setOutlineFailed] = useState(false);
  const [metadataFailed, setMetadataFailed] = useState(false);
  const [navigationFailed, setNavigationFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setOutline(null);
    setMetadata(null);
    setOutlineFailed(false);
    setMetadataFailed(false);
    setNavigationFailed(false);
    void pdf.getOutline().then((items) => { if (!cancelled) setOutline(items ?? []); })
      .catch(() => { if (!cancelled) setOutlineFailed(true); });
    void pdf.getMetadata().then((value) => { if (!cancelled) setMetadata(value); })
      .catch(() => { if (!cancelled) setMetadataFailed(true); });
    return () => { cancelled = true; };
  }, [pdf]);

  const navigate = (destination: string | unknown[]) => {
    setNavigationFailed(false);
    void onDestination(destination).catch(() => setNavigationFailed(true));
  };
  return (
    <aside className="pdf-sidebar" aria-label={t("pdfSidebar")}>
      <div className="pdf-sidebar-header">
        <span>{t("pdfSidebar")}</span>
        <button type="button" className="pdf-close-sidebar" aria-label={t("pdfCloseSidebar")} title={t("pdfCloseSidebar")} onClick={onClose}>×</button>
      </div>
      <div className="pdf-sidebar-tabs" role="tablist" aria-label={t("pdfSidebar")}>
        {TABS.map(({ id, key }) => <button key={id} type="button" role="tab" id={`pdf-tab-${id}`} aria-selected={tab === id}
          aria-controls="pdf-sidebar-panel" onClick={() => onTab(id)}>{t(key)}</button>)}
      </div>
      <div className="pdf-sidebar-panel" id="pdf-sidebar-panel" role="tabpanel" aria-labelledby={`pdf-tab-${tab}`}>
        {tab === "thumbnails" ? <ThumbnailList pdf={pdf} page={page} labels={labels} t={t} onPage={onPage} onThumbnailRendered={onThumbnailRendered} /> : null}
        {tab === "outline" ? <div className="pdf-outline-content">
          {navigationFailed ? <p className="pdf-sidebar-message" role="alert">{t("pdfNavigationFailed")}</p> : null}
          {outlineFailed ? <p className="pdf-sidebar-message" role="status">{t("pdfOutlineFailed")}</p>
            : outline === null ? <p className="pdf-sidebar-message" role="status">{t("pdfLoading")}</p>
              : outline.length ? <ul className="pdf-outline-list">{outline.map((item, index) => <OutlineItem key={index} item={item} t={t} onNavigate={navigate} />)}</ul>
                : <p className="pdf-sidebar-message">{t("pdfNoOutline")}</p>}
        </div> : null}
        {tab === "info" ? <DocumentInfo metadata={metadata} failed={metadataFailed} pdf={pdf} name={name} size={size} locale={locale} t={t} /> : null}
      </div>
    </aside>
  );
}

function OutlineItem({ item, t, onNavigate }: { item: Outline[number]; t: T; onNavigate: (destination: string | unknown[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const children: Outline = item.items ?? [];
  const destination = typeof item.dest === "string" || Array.isArray(item.dest) ? item.dest : null;
  return <li>
    <div className="pdf-outline-row">
      {children.length ? <button type="button" className="pdf-outline-expand" aria-expanded={expanded} aria-label={t(expanded ? "pdfCollapseBookmark" : "pdfExpandBookmark")}
        onClick={() => setExpanded((value) => !value)}>{expanded ? "▾" : "▸"}</button> : <span className="pdf-outline-spacer" />}
      <button type="button" className="pdf-outline-link" title={item.title} disabled={destination === null}
        style={{ fontWeight: item.bold ? 600 : undefined, fontStyle: item.italic ? "italic" : undefined }}
        onClick={() => { if (destination !== null) onNavigate(destination); }}>{item.title || t("pdfUnnamedBookmark")}</button>
    </div>
    {expanded && children.length ? <ul>{children.map((child, index) => <OutlineItem key={index} item={child} t={t} onNavigate={onNavigate} />)}</ul> : null}
  </li>;
}

const THUMB_HEIGHT = 176;
function ThumbnailList({ pdf, page, labels, t, onPage, onThumbnailRendered }: Pick<Props, "pdf" | "page" | "labels" | "t" | "onPage" | "onThumbnailRendered">) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 6 });
  useEffect(() => {
    const scroll = scrollRef.current!;
    const measure = () => {
      const start = Math.max(0, Math.floor(scroll.scrollTop / THUMB_HEIGHT) - 2);
      const end = Math.min(pdf.numPages, Math.ceil((scroll.scrollTop + scroll.clientHeight) / THUMB_HEIGHT) + 2);
      setRange((old) => old.start === start && old.end === end ? old : { start, end });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    scroll.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", measure); };
  }, [pdf]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const top = (page - 1) * THUMB_HEIGHT;
    if (top < scroll.scrollTop || top + THUMB_HEIGHT > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = Math.max(0, top - (scroll.clientHeight - THUMB_HEIGHT) / 2);
    }
  }, [page]);
  const numbers = Array.from({ length: Math.max(0, range.end - range.start) }, (_, index) => range.start + index + 1);
  return <div className="pdf-thumbnails" ref={scrollRef} aria-label={t("pdfThumbnails")}>
    <div className="pdf-thumbnail-spacer" style={{ height: pdf.numPages * THUMB_HEIGHT }}>
      {numbers.map((number) => <Thumbnail key={number} pdf={pdf} number={number} label={labels?.[number - 1]} active={page === number} t={t} onPage={onPage} onThumbnailRendered={onThumbnailRendered} />)}
    </div>
  </div>;
}

function Thumbnail({ pdf, number, label, active, t, onPage, onThumbnailRendered }: {
  pdf: PDFDocumentProxy; number: number; label?: string; active: boolean; t: T; onPage: (page: number) => void; onThumbnailRendered: Props["onThumbnailRendered"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | undefined;
    let thumbnailPage: PDFPageProxy | undefined;
    const canvas = canvasRef.current!;
    setState("loading");
    void (async () => {
      try {
        const page = thumbnailPage = await pdf.getPage(number);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(126 / natural.width, 136 / natural.height);
        const viewport = page.getViewport({ scale });
        const density = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.max(1, Math.floor(viewport.width * density));
        canvas.height = Math.max(1, Math.floor(viewport.height * density));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        task = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0], annotationMode: AnnotationMode.DISABLE });
        await task.promise;
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("failed");
      } finally {
        // PDFViewer only cleans this page when its main-page cache does not use it.
        if (thumbnailPage) onThumbnailRendered(number, thumbnailPage);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      canvas.width = 0;
      canvas.height = 0;
      // The main viewer shares this PDFPageProxy; do not call page.cleanup().
    };
  }, [pdf, number, onThumbnailRendered]);
  const pageLabel = t("pageOf", { page: number, count: pdf.numPages });
  return <button type="button" className="pdf-thumbnail" style={{ top: (number - 1) * THUMB_HEIGHT, height: THUMB_HEIGHT }} data-page-number={number}
    aria-label={label && label !== String(number) ? `${pageLabel} (${label})` : pageLabel} aria-current={active ? "page" : undefined}
    aria-busy={state === "loading"} onClick={() => onPage(number)}>
    <span className="pdf-thumbnail-image"><canvas ref={canvasRef} aria-hidden="true" style={{ visibility: state === "ready" ? "visible" : "hidden" }} />
      {state !== "ready" ? <span className="pdf-thumbnail-status">{state === "failed" ? t("pdfThumbnailFailed") : "…"}</span> : null}</span>
    <span className="pdf-thumbnail-label">{label || number}{label && label !== String(number) ? ` · ${number}` : ""}</span>
  </button>;
}

function DocumentInfo({ metadata, failed, pdf, name, size, locale, t }: {
  metadata: Metadata | null; failed: boolean; pdf: PDFDocumentProxy; name: string; size: number; locale: "en" | "zh"; t: T;
}) {
  const info = (metadata?.info ?? {}) as Record<string, unknown>;
  const text = (key: string, xmp?: string) => {
    const value: unknown = info[key] || (xmp ? metadata?.metadata?.get(xmp) : "");
    const normalized = Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : value;
    return typeof normalized === "string" && normalized.trim() ? normalized.replace(/\0/g, "") : "—";
  };
  const date = (key: string) => {
    const value = info[key];
    if (typeof value !== "string") return "—";
    const parsed = PDFDateString.toDateObject(value);
    return parsed ? parsed.toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : value;
  };
  const rows: [CopyKey, string | number][] = [
    ["pdfFileName", name], ["pdfFileSize", formatSize(size)], ["pdfPageTotal", pdf.numPages],
    ["pdfTitle", text("Title", "dc:title")], ["pdfAuthor", text("Author", "dc:creator")],
    ["pdfSubject", text("Subject", "dc:description")], ["pdfKeywords", text("Keywords", "pdf:keywords")],
    ["pdfCreated", date("CreationDate")], ["pdfModified", date("ModDate")],
    ["pdfCreator", text("Creator", "xmp:creatortool")], ["pdfProducer", text("Producer", "pdf:producer")],
    ["pdfVersion", text("PDFFormatVersion")],
  ];
  return <div className="pdf-info-content">
    {failed ? <p className="pdf-sidebar-message" role="status">{t("pdfInfoFailed")}</p> : !metadata ? <p className="pdf-sidebar-message" role="status">{t("pdfLoading")}</p> : null}
    <dl className="pdf-document-info">{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
  </div>;
}
