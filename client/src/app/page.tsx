'use client';

import { useState, useEffect, useRef } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { io } from 'socket.io-client';
import {
  Share2, Trash2, Play, ServerCrash,
  Loader2, MousePointerClick, Type, ScanSearch
} from 'lucide-react';

const API = 'http://localhost:3001';

export default function Home() {
  const { steps, targetUrl, setTargetUrl, addStep, removeStep, updateStep, clearSteps } =
    useWorkflowStore();

  const [proxyHtml, setProxyHtml]         = useState<string>('');
  const [sessionId, setSessionId]         = useState<string | null>(null);
  const [navigating, setNavigating]       = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [runLogs, setRunLogs]             = useState<string[]>([]);
  const [socket, setSocket]               = useState<any>(null);
  const [currentUrl, setCurrentUrl]       = useState('');

  // Refs so the single-mount event handler always has fresh values
  const sessionIdRef  = useRef<string | null>(null);
  const addStepRef    = useRef(addStep);
  const setTargetRef  = useRef(setTargetUrl);
  const inputDebounce = useRef<NodeJS.Timeout | null>(null);

  // Keep refs in sync with latest values
  useEffect(() => { sessionIdRef.current  = sessionId;   }, [sessionId]);
  useEffect(() => { addStepRef.current    = addStep;     }, [addStep]);
  useEffect(() => { setTargetRef.current  = setTargetUrl;}, [setTargetUrl]);

  // Socket
  useEffect(() => {
    const s = io(API);
    setSocket(s);
    return () => { s.close(); };
  }, []);

  // ── postMessage handler — mounted once, uses refs for fresh values ──────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || !data.type) return;

      const sid     = sessionIdRef.current;
      const doAdd   = addStepRef.current;
      const doNavUrl= setTargetRef.current;

      // ────── Input / typing ──────────────────────────────────────────────
      if (data.type === 'USER_INPUT_CHANGE') {
        // Record fill step immediately (upsert handled by store)
        doAdd({ action: 'fill', selector: data.selector, value: data.value });

        // Debounce fill sync to backend so it's ready when the user clicks Submit
        if (!sid) return;
        if (inputDebounce.current) clearTimeout(inputDebounce.current);
        inputDebounce.current = setTimeout(() => {
          fetch(`${API}/api/proxy/interact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, action: 'fill', selector: data.selector, value: data.value })
          }).catch(console.error);
        }, 500);
        return;
      }

      // ────── Click ───────────────────────────────────────────────────────
      if (data.type === 'USER_CLICKED_ELEMENT') {
        const { tagName, selector, text, value, isNav, isInput, href } = data;

        /* Clicking an input/textarea → record fill stub (no backend call) */
        if (isInput) {
          doAdd({ action: 'fill', selector, value: value || '' });
          return;
        }

        /* All other clicks: always record the step */
        doAdd({ action: 'click', selector, text });

        /* Only navigation clicks need backend sync + iframe refresh */
        if (!isNav || !sid) return;

        setNavigating(true);
        fetch(`${API}/api/proxy/interact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Pass href so the backend can use page.goto(href) — much more reliable
          // than page.click(selector) for links, and avoids selector mismatch issues.
          body: JSON.stringify({ sessionId: sid, action: 'click', selector, href: href || '' })
        })
          .then(r => r.json())
          .then(result => {
            if (result.html) {
              setProxyHtml(result.html);
              if (result.url) {
                doNavUrl(result.url);
                setCurrentUrl(result.url);
              }
            } else if (result.error) {
              console.warn('[navigate] backend error:', result.error);
            }
          })
          .catch(console.error)
          .finally(() => setNavigating(false));
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  // mount once — all mutable values accessed through refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load proxy session ────────────────────────────────────────────────────
  const loadProxy = async () => {
    if (!targetUrl) return;
    setLoadingSession(true);
    clearSteps();
    setProxyHtml('');
    setSessionId(null);
    try {
      const res  = await fetch(`${API}/api/proxy/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSessionId(data.sessionId);
      setCurrentUrl(targetUrl);
      setProxyHtml(data.html);
    } catch (e: any) {
      setProxyHtml(
        `<div style="font-family:sans-serif;padding:2rem;color:#e11d48">
           <h2>Failed to load</h2><p>${e.message}</p>
         </div>`
      );
    } finally {
      setLoadingSession(false);
    }
  };

  // ── Run workflow ──────────────────────────────────────────────────────────
  const runWorkflow = async () => {
    setRunLogs(['Dispatching workflow to Queue…']);
    try {
      const createRes = await fetch(`${API}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Visual Flow', config: { steps, url: targetUrl } })
      });
      const workflow = await createRes.json();
      const runRes   = await fetch(`${API}/api/workflows/run/${workflow.id}`, { method: 'POST' });
      const { jobId } = await runRes.json();
      if (socket) {
        socket.emit('join_job', jobId);
        socket.on('log', (logInfo: any) => {
          setRunLogs(prev => [
            ...prev,
            `[${new Date(logInfo.timestamp).toLocaleTimeString()}] ${logInfo.message}`
          ]);
        });
      }
    } catch {
      setRunLogs(prev => [...prev, 'Failed to execute workflow.']);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const actionBadge = (action: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      click:   { label: 'CLICK',   cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' },
      fill:    { label: 'FILL',    cls: 'bg-blue-500/20 text-blue-400 border-blue-500/40' },
      extract: { label: 'EXTRACT', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/40' },
    };
    const b = map[action] ?? { label: action.toUpperCase(), cls: 'bg-neutral-700 text-neutral-400 border-neutral-600' };
    return (
      <span className={`px-1.5 py-0.5 text-[9px] font-bold border rounded tracking-widest ${b.cls}`}>
        {b.label}
      </span>
    );
  };

  const sidebarAccentClass = (action: string) => {
    if (action === 'click')   return 'before:bg-emerald-500';
    if (action === 'fill')    return 'before:bg-blue-500';
    if (action === 'extract') return 'before:bg-amber-500';
    return 'before:bg-neutral-500';
  };

  return (
    <main className="flex h-screen bg-neutral-950 text-neutral-100 overflow-hidden font-sans">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-[300px] border-r border-neutral-800 bg-neutral-900 flex flex-col z-20">
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
          <Share2 className="text-emerald-400 w-4 h-4" />
          <span className="text-sm font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
            Scraper Builder
          </span>
          {sessionId && (
            <span className="ml-auto flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        {/* Steps list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase text-neutral-500 font-bold tracking-widest">
              Steps ({steps.length})
            </span>
            {steps.length > 0 && (
              <button
                onClick={clearSteps}
                className="text-[10px] text-neutral-600 hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          {steps.length === 0 ? (
            <div className="mt-6 text-center border border-dashed border-neutral-800 rounded-xl p-6">
              <div className="text-3xl mb-2">👆</div>
              <p className="text-xs text-neutral-500">
                Load a URL then click elements in the preview to build your workflow.
              </p>
            </div>
          ) : (
            steps.map((step, idx) => (
              <div
                key={step.id}
                className={`relative group px-3 py-2.5 bg-neutral-800 border border-neutral-700/60 rounded-lg
                  before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2
                  before:w-[3px] before:rounded-full before:ml-[-1px] ${sidebarAccentClass(step.action)}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-[10px] text-neutral-600 shrink-0 font-mono">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    {actionBadge(step.action)}
                    <select
                      value={step.action}
                      onChange={(e) => updateStep(step.id, { action: e.target.value as any })}
                      className="bg-neutral-900 text-neutral-300 border border-neutral-700 rounded px-1.5 py-0.5
                        text-[11px] focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                    >
                      <option value="click">Click</option>
                      <option value="fill">Fill</option>
                      <option value="extract">Extract</option>
                    </select>
                  </div>
                  <button
                    onClick={() => removeStep(step.id)}
                    className="text-neutral-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* Selector pill */}
                <div className="mt-1.5 text-[10px] text-neutral-500 font-mono truncate bg-neutral-950/60
                  px-2 py-0.5 rounded border border-neutral-800">
                  {step.selector || '—'}
                </div>

                {/* Fill value input */}
                {step.action === 'fill' && (
                  <input
                    type="text"
                    placeholder="Value to fill…"
                    value={step.value || ''}
                    onChange={(e) => updateStep(step.id, { value: e.target.value })}
                    className="w-full mt-1.5 bg-neutral-950 border border-neutral-700 text-[11px] rounded
                      px-2 py-1 text-neutral-300 focus:outline-none focus:border-blue-500 placeholder-neutral-600"
                  />
                )}

                {/* Extracted text preview */}
                {step.action === 'extract' && step.text && (
                  <div className="mt-1.5 text-[10px] text-neutral-500 italic truncate
                    border-l-2 border-amber-500/30 pl-1.5">
                    "{step.text}"
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Run button */}
        <div className="px-3 py-3 border-t border-neutral-800">
          <button
            onClick={runWorkflow}
            disabled={steps.length === 0}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-bold text-sm
              bg-emerald-500 hover:bg-emerald-400 text-neutral-950 transition-all
              disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
          >
            <Play className="w-4 h-4" fill="currentColor" />
            Launch Scraper
          </button>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0">
        {/* URL bar */}
        <header className="h-14 flex items-center px-4 gap-3 border-b border-neutral-800 bg-neutral-900 shrink-0">
          <div className="flex-1 flex bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden">
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadProxy()}
              className="flex-1 bg-transparent px-4 py-2 text-sm text-neutral-200 focus:outline-none
                placeholder-neutral-600 font-mono"
              placeholder="https://example.com"
            />
            <button
              onClick={loadProxy}
              disabled={loadingSession}
              className="px-5 bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold transition-colors
                flex items-center gap-2 border-l border-neutral-800 disabled:opacity-60"
            >
              {loadingSession && <Loader2 className="w-4 h-4 animate-spin" />}
              {loadingSession ? 'Loading…' : 'Preview Proxy'}
            </button>
          </div>

          {currentUrl && (
            <span className="text-[11px] text-neutral-500 font-mono truncate max-w-[260px]" title={currentUrl}>
              {currentUrl}
            </span>
          )}
        </header>

        {/* Preview area */}
        <div className="flex-1 flex gap-3 p-3 overflow-hidden min-h-0">
          {/* iframe wrapper */}
          <div className="flex-1 bg-white rounded-xl overflow-hidden border border-neutral-800 shadow-2xl relative">
            {/* Navigation overlay */}
            {navigating && (
              <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center rounded-xl">
                <div className="bg-neutral-900 border border-neutral-700 rounded-xl px-5 py-3
                  flex items-center gap-3 shadow-2xl">
                  <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
                  <span className="text-sm text-neutral-300 font-medium">Navigating…</span>
                </div>
              </div>
            )}

            {proxyHtml ? (
              <iframe
                srcDoc={proxyHtml}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                className="w-full h-full bg-white"
                title="Proxy Preview"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center
                text-neutral-500 bg-neutral-950/80 gap-4">
                <ServerCrash className="w-10 h-10 opacity-30" />
                <p className="text-sm">
                  Enter a URL and click{' '}
                  <span className="text-emerald-400 font-semibold">Preview Proxy</span> to start.
                </p>
              </div>
            )}
          </div>

          {/* Live logs */}
          {runLogs.length > 0 && (
            <div className="w-72 flex flex-col bg-neutral-950 rounded-xl border border-neutral-800 overflow-hidden shrink-0">
              <div className="px-3 py-2 border-b border-neutral-800 bg-neutral-900 text-[10px]
                font-bold tracking-widest text-emerald-400 flex items-center justify-between uppercase">
                <span>Live Logs</span>
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              </div>
              <div className="flex-1 p-3 overflow-y-auto space-y-1.5 font-mono text-[10px] text-neutral-400">
                {runLogs.map((log, i) => (
                  <div key={i} className="border-l border-neutral-800 pl-2 leading-relaxed">
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
