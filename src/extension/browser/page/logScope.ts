// Which part of a tab's console and network log belongs to the current page. Pure.
//
// The logs record everything since the bridge attached, across page loads. By default the lists show
// the current document only, starting with the request that produced it, so its HTTP redirects (one
// CDP request id, the document's loader id) stay visible. Everything is cut by `seq`, not by loader
// or frame id, so the page's iframes, service-worker-served requests and anything sent while the
// navigation was under way (an unload beacon of the previous page) are shown; same-document
// navigations (pushState, hash changes) do not start a new page. Requests the previous page started
// before the navigation are left out, even when they ended after it (most are cancelled by it).

export interface ScopeNavigation {
  seq: number;
  /** Wall-clock time it committed, ms since epoch. */
  time: number;
  loaderId: string | undefined;
  sameDocument: boolean;
}

export interface PageScope {
  /** Entries with `seq >= startSeq` belong to the current page; 0: everything recorded does. */
  startSeq: number;
  /** When the current page committed (undefined when startSeq is 0). */
  loadedAt?: number;
}

/**
 * The current page's part of the logs: from the first request with the document's loader id as its
 * request id (the navigation request, the first of its redirects), else from the navigation itself.
 */
export function currentPageScope(input: { navigations: ScopeNavigation[]; loaderId: string | undefined; requests: Array<{ seq: number; requestId: string }> }): PageScope {
  const loads = input.navigations.filter(n => !n.sameDocument);
  let current: ScopeNavigation | undefined;
  for (let i = loads.length - 1; i >= 0; i--) {
    if (input.loaderId !== undefined && loads[i]!.loaderId === input.loaderId) {
      current = loads[i];
      break;
    }
  }
  // The bridge attached while this document was already showing: all it recorded is this page's.
  if (!current) return { startSeq: 0 };
  const request = input.requests.find(r => r.requestId === input.loaderId && r.seq < current!.seq);
  return { startSeq: request?.seq ?? current.seq, loadedAt: current.time };
}

/** The header's note about what the page scope left out, or '' when nothing was. */
export function earlierNote(hidden: number, noun: { one: string; many: string }): string {
  if (hidden <= 0) return '';
  return `${hidden} ${hidden === 1 ? noun.one : noun.many} from earlier pages left out (allPages: true lists them)`;
}
