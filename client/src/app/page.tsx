'use client';

import { useState, useEffect, useRef } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { io } from 'socket.io-client';
import {
  Share2, Trash2, Play, ServerCrash, Loader2, MousePointerClick,
  Type, ScanSearch, Code, RepeatIcon, Clock, Tag, Plus, Download,
  Table, ChevronDown, ChevronRight, PlayCircle, CheckCircle2, XCircle
} from 'lucide-react';

const API = 'http://localhost:3001';

export default function Home() {
  const {
    steps, targetUrl, extractionTemplate, scrapedData,
    setTargetUrl, addStep, removeStep, updateStep, clearSteps,
    addExtractionField, updateExtractionField, removeExtractionField, clearExtractionTemplate,
    setScrapedData, clearScrapedData
  } = useWorkflowStore();

  const [proxyHtml, setProxyHtml] = useState<string>('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [socket, setSocket] = useState<any>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [activeTab, setActiveTab] = useState<'steps' | 'template' | 'data'>('steps');
  const [showAddStepMenu, setShowAddStepMenu] = useState(false);
  const [expandedIterateSteps, setExpandedIterateSteps] = useState<Set<string>>(new Set());
  // JS step test runner state: stepId → { running, result, error }
  const [jsTestResults, setJsTestResults] = useState<Record<string, { running: boolean; result?: string; error?: string }>>({});

  // Refs so the single-mount event handler always has fresh values
  const sessionIdRef = useRef<string | null>(null);
  const addStepRef = useRef(addStep);
  const setTargetRef = useRef(setTargetUrl);
  const inputDebounce = useRef<NodeJS.Timeout | null>(null);

  // Keep refs in sync with latest values
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { addStepRef.current = addStep; }, [addStep]);
  useEffect(() => { setTargetRef.current = setTargetUrl; }, [setTargetUrl]);

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

      const sid = sessionIdRef.current;
      const doAdd = addStepRef.current;
      const doNavUrl = setTargetRef.current;

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
      const res = await fetch(`${API}/api/proxy/session`, {
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

  // ── Run JS step in live session ───────────────────────────────────────────
  const runJsInSession = async (stepId: string, code: string) => {
    if (!sessionId) {
      setJsTestResults(prev => ({ ...prev, [stepId]: { running: false, error: 'No active session — click Preview Proxy first.' } }));
      return;
    }
    setJsTestResults(prev => ({ ...prev, [stepId]: { running: true } }));
    try {
      const res = await fetch(`${API}/api/proxy/execute-js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, code })
      });
      const data = await res.json();
      if (data.error) {
        setJsTestResults(prev => ({ ...prev, [stepId]: { running: false, error: data.error } }));
      } else {
        const resultStr = data.result !== null && data.result !== undefined
          ? JSON.stringify(data.result, null, 2)
          : '(null)';
        setJsTestResults(prev => ({ ...prev, [stepId]: { running: false, result: resultStr } }));
      }
    } catch (e: any) {
      setJsTestResults(prev => ({ ...prev, [stepId]: { running: false, error: e.message } }));
    }
  };

  // ── Run workflow ──────────────────────────────────────────────────────────
  const runWorkflow = async () => {
    setRunLogs(['🚀 Dispatching workflow to Queue…']);
    setActiveTab('data');
    clearScrapedData();

    // Update preview to show target URL
    setCurrentUrl(targetUrl);

    try {
      const createRes = await fetch(`${API}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Visual Flow',
          config: { steps, url: targetUrl, extractionTemplate }
        })
      });
      const workflow = await createRes.json();
      const runRes = await fetch(`${API}/api/workflows/run/${workflow.id}`, { method: 'POST' });
      const { jobId } = await runRes.json();

      if (socket) {
        // Remove old listeners to avoid duplicates on re-runs
        socket.off('log');
        socket.off('scraped_data');

        socket.emit('join_job', jobId);

        socket.on('log', (logInfo: any) => {
          setRunLogs(prev => [
            ...prev,
            `[${new Date(logInfo.timestamp).toLocaleTimeString()}] ${logInfo.message}`
          ]);
        });

        socket.on('scraped_data', (data: any) => {
          const results = data.results || [];
          setScrapedData(results);
          setRunLogs(prev => [...prev, `✅ Extracted ${results.length} record${results.length !== 1 ? 's' : ''}`]);
          // Auto-switch to data tab once results arrive
          setActiveTab('data');
        });
      }
    } catch {
      setRunLogs(prev => [...prev, '❌ Failed to execute workflow.']);
    }
  };

  // ── Manual step additions ────────────────────────────────────────────────
  const manualAddStep = (stepType: 'iterate' | 'javascript' | 'wait') => {
    if (stepType === 'iterate') {
      addStep({
        action: 'iterate',
        selector: '',
        itemSelector: '.card, .item, [data-item]',
        iterateSteps: []
      });
    } else if (stepType === 'javascript') {
      addStep({
        action: 'javascript',
        jsCode: '// Execute custom JavaScript\n// Return value will be used in workflow\nreturn document.querySelectorAll(\'.item\').length;'
      });
    } else if (stepType === 'wait') {
      addStep({
        action: 'wait',
        waitMs: 1000
      });
    }
    setShowAddStepMenu(false);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const actionBadge = (action: string) => {
    const map: Record<string, { label: string; cls: string; icon: any }> = {
      click: { label: 'CLICK', cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', icon: MousePointerClick },
      fill: { label: 'FILL', cls: 'bg-blue-500/20 text-blue-400 border-blue-500/40', icon: Type },
      extract: { label: 'EXTRACT', cls: 'bg-amber-500/20 text-amber-400 border-amber-500/40', icon: ScanSearch },
      iterate: { label: 'LOOP', cls: 'bg-purple-500/20 text-purple-400 border-purple-500/40', icon: RepeatIcon },
      javascript: { label: 'JS', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', icon: Code },
      wait: { label: 'WAIT', cls: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40', icon: Clock },
    };
    const b = map[action] ?? { label: action.toUpperCase(), cls: 'bg-neutral-700 text-neutral-400 border-neutral-600', icon: null };
    const Icon = b.icon;
    return (
      <span className={`px-1.5 py-0.5 text-[9px] font-bold border rounded tracking-widest flex items-center gap-1 ${b.cls}`}>
        {Icon && <Icon className="w-2.5 h-2.5" />}
        {b.label}
      </span>
    );
  };

  const sidebarAccentClass = (action: string) => {
    if (action === 'click') return 'before:bg-emerald-500';
    if (action === 'fill') return 'before:bg-blue-500';
    if (action === 'extract') return 'before:bg-amber-500';
    if (action === 'iterate') return 'before:bg-purple-500';
    if (action === 'javascript') return 'before:bg-yellow-500';
    if (action === 'wait') return 'before:bg-cyan-500';
    return 'before:bg-neutral-500';
  };

  const toggleIterateExpand = (id: string) => {
    setExpandedIterateSteps(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const exportData = () => {
    const json = JSON.stringify(scrapedData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scraped-data-${Date.now()}.json`;
    a.click();
  };

  return (
    <main className="flex h-screen bg-neutral-950 text-neutral-100 overflow-hidden font-sans">

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-[340px] border-r border-neutral-800 bg-neutral-900 flex flex-col z-20">
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

        {/* Tabs */}
        <div className="flex border-b border-neutral-800 bg-neutral-900">
          <button
            onClick={() => setActiveTab('steps')}
            className={`flex-1 px-3 py-2 text-[11px] font-bold transition-colors ${activeTab === 'steps'
              ? 'text-emerald-400 border-b-2 border-emerald-400'
              : 'text-neutral-500 hover:text-neutral-300'
              }`}
          >
            STEPS ({steps.length})
          </button>
          <button
            onClick={() => setActiveTab('template')}
            className={`flex-1 px-3 py-2 text-[11px] font-bold transition-colors ${activeTab === 'template'
              ? 'text-amber-400 border-b-2 border-amber-400'
              : 'text-neutral-500 hover:text-neutral-300'
              }`}
          >
            <Tag className="w-3 h-3 inline mr-1" />
            TEMPLATE ({extractionTemplate.length})
          </button>
          <button
            onClick={() => setActiveTab('data')}
            className={`flex-1 px-3 py-2 text-[11px] font-bold transition-colors ${activeTab === 'data'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-neutral-500 hover:text-neutral-300'
              }`}
          >
            <Table className="w-3 h-3 inline mr-1" />
            DATA ({scrapedData.length})
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {/* ─── STEPS TAB ─────────────────────────────────────────────── */}
          {activeTab === 'steps' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase text-neutral-500 font-bold tracking-widest">
                  Workflow Steps
                </span>
                <div className="flex gap-1">
                  {steps.length > 0 && (
                    <button
                      onClick={clearSteps}
                      className="text-[10px] text-neutral-600 hover:text-red-400 transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                  <div className="relative">
                    <button
                      onClick={() => setShowAddStepMenu(!showAddStepMenu)}
                      className="flex items-center gap-1 px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-[10px] text-emerald-400 rounded border border-neutral-700 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Add
                    </button>
                    {showAddStepMenu && (
                      <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 min-w-[160px]">
                        <button
                          onClick={() => manualAddStep('iterate')}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-neutral-700 text-left transition-colors"
                        >
                          <RepeatIcon className="w-3.5 h-3.5 text-purple-400" />
                          <span>Loop / Iterate</span>
                        </button>
                        <button
                          onClick={() => manualAddStep('javascript')}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-neutral-700 text-left transition-colors"
                        >
                          <Code className="w-3.5 h-3.5 text-yellow-400" />
                          <span>JavaScript</span>
                        </button>
                        <button
                          onClick={() => manualAddStep('wait')}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-neutral-700 text-left transition-colors"
                        >
                          <Clock className="w-3.5 h-3.5 text-cyan-400" />
                          <span>Wait / Delay</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {steps.length === 0 ? (
                <div className="mt-6 text-center border border-dashed border-neutral-800 rounded-xl p-6">
                  <div className="text-3xl mb-2">👆</div>
                  <p className="text-xs text-neutral-500">
                    Load a URL then click elements in the preview to build your workflow.
                  </p>
                  <p className="text-xs text-neutral-600 mt-2">
                    Or use the <span className="text-emerald-400">+ Add</span> button for advanced steps.
                  </p>
                </div>
              ) : (
                steps.map((step, idx) => (
                  <div key={step.id} className="space-y-1">
                    <div
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
                          {step.action === 'iterate' && (
                            <button
                              onClick={() => toggleIterateExpand(step.id)}
                              className="text-neutral-500 hover:text-neutral-300"
                            >
                              {expandedIterateSteps.has(step.id) ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                        <button
                          onClick={() => removeStep(step.id)}
                          className="text-neutral-600 hover:text-red-400 transition-colors shrink-0"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      {/* ── Action type switcher (click / fill / extract) ── */}
                      {(step.action === 'click' || step.action === 'fill' || step.action === 'extract') && (
                        <div className="mt-2 flex gap-1">
                          {(['click', 'fill', 'extract'] as const).map((a) => {
                            const cfgMap = {
                              click:   { label: 'Click',   icon: MousePointerClick, active: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400', idle: 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:text-neutral-300' },
                              fill:    { label: 'Fill',    icon: Type,              active: 'bg-blue-500/20 border-blue-500/50 text-blue-400',           idle: 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:text-neutral-300' },
                              extract: { label: 'Extract', icon: ScanSearch,        active: 'bg-amber-500/20 border-amber-500/50 text-amber-400',        idle: 'bg-neutral-900 border-neutral-700 text-neutral-500 hover:text-neutral-300' },
                            };
                            const cfg = cfgMap[a];
                            const Icon = cfg.icon;
                            const isActive = step.action === a;
                            return (
                              <button
                                key={a}
                                onClick={() => updateStep(step.id, { action: a })}
                                className={`flex-1 flex items-center justify-center gap-1 py-1 text-[9px] font-bold border rounded transition-all ${isActive ? cfg.active : cfg.idle}`}
                              >
                                <Icon className="w-2.5 h-2.5" />
                                {cfg.label}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Selector for click/fill/extract */}
                      {(step.action === 'click' || step.action === 'fill' || step.action === 'extract') && (
                        <div className="mt-1.5 text-[10px] text-neutral-500 font-mono truncate bg-neutral-950/60
                          px-2 py-0.5 rounded border border-neutral-800">
                          {step.selector || '—'}
                        </div>
                      )}

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

                      {/* Extract: label field + text preview */}
                      {step.action === 'extract' && (
                        <div className="mt-1.5 space-y-1.5">
                          <input
                            type="text"
                            placeholder="Label (e.g., title, price)"
                            value={step.label || ''}
                            onChange={(e) => updateStep(step.id, { label: e.target.value })}
                            className="w-full bg-neutral-950 border border-neutral-700 text-[11px] rounded
                              px-2 py-1 text-neutral-300 focus:outline-none focus:border-amber-500 placeholder-neutral-600"
                          />
                          {step.text && (
                            <div className="text-[10px] text-neutral-500 italic truncate border-l-2 border-amber-500/30 pl-1.5">
                              "{step.text}"
                            </div>
                          )}
                        </div>
                      )}

                      {/* Iterate controls */}
                      {step.action === 'iterate' && (
                        <div className="mt-2 space-y-1.5">
                          <input
                            type="text"
                            placeholder="Container selector (e.g., .cards)"
                            value={step.selector || ''}
                            onChange={(e) => updateStep(step.id, { selector: e.target.value })}
                            className="w-full bg-neutral-950 border border-neutral-700 text-[10px] rounded
                              px-2 py-1 text-neutral-300 focus:outline-none focus:border-purple-500 placeholder-neutral-600 font-mono"
                          />
                          <input
                            type="text"
                            placeholder="Item selector (e.g., .card)"
                            value={step.itemSelector || ''}
                            onChange={(e) => updateStep(step.id, { itemSelector: e.target.value })}
                            className="w-full bg-neutral-950 border border-neutral-700 text-[10px] rounded
                              px-2 py-1 text-neutral-300 focus:outline-none focus:border-purple-500 placeholder-neutral-600 font-mono"
                          />
                        </div>
                      )}

                      {/* JavaScript code editor + Test button */}
                      {step.action === 'javascript' && (
                        <div className="mt-1.5 space-y-1.5">
                          <textarea
                            value={step.jsCode || ''}
                            onChange={(e) => updateStep(step.id, { jsCode: e.target.value })}
                            placeholder="// Your JavaScript code here"
                            className="w-full bg-neutral-950 border border-neutral-700 text-[10px] rounded
                              px-2 py-1.5 text-neutral-300 focus:outline-none focus:border-yellow-500 placeholder-neutral-600 font-mono resize-none"
                            rows={4}
                          />
                          {/* Test runner button */}
                          <button
                            onClick={() => runJsInSession(step.id, step.jsCode || '')}
                            disabled={!step.jsCode || jsTestResults[step.id]?.running}
                            className="flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/10 hover:bg-yellow-500/20
                              border border-yellow-500/30 text-yellow-400 text-[10px] font-semibold rounded
                              transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {jsTestResults[step.id]?.running
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <PlayCircle className="w-3 h-3" />
                            }
                            {jsTestResults[step.id]?.running ? 'Running…' : 'Test in Session'}
                          </button>
                          {/* Result / error display */}
                          {jsTestResults[step.id] && !jsTestResults[step.id]?.running && (
                            <div className={`rounded border px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap break-all max-h-24 overflow-y-auto
                              ${
                                jsTestResults[step.id]?.error
                                  ? 'bg-red-950/40 border-red-500/30 text-red-400'
                                  : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                              }`}
                            >
                              {jsTestResults[step.id]?.error
                                ? <><XCircle className="w-3 h-3 inline mr-1" />{jsTestResults[step.id]?.error}</>
                                : <><CheckCircle2 className="w-3 h-3 inline mr-1" />{jsTestResults[step.id]?.result}</>}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Wait duration */}
                      {step.action === 'wait' && (
                        <input
                          type="number"
                          placeholder="Milliseconds"
                          value={step.waitMs || 1000}
                          onChange={(e) => updateStep(step.id, { waitMs: parseInt(e.target.value) || 1000 })}
                          className="w-full mt-1.5 bg-neutral-950 border border-neutral-700 text-[11px] rounded
                            px-2 py-1 text-neutral-300 focus:outline-none focus:border-cyan-500 placeholder-neutral-600"
                        />
                      )}
                    </div>

                    {/* Nested iterate steps */}
                    {step.action === 'iterate' && expandedIterateSteps.has(step.id) && (
                      <div className="ml-6 pl-3 border-l-2 border-purple-500/30 space-y-1">
                        <div className="text-[9px] text-neutral-600 uppercase tracking-wider mb-1">
                          Steps to repeat for each item:
                        </div>
                        <div className="text-[10px] text-neutral-500 bg-neutral-900 rounded px-2 py-1.5 border border-neutral-800">
                          Add steps by clicking elements in preview while this loop is expanded
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* ─── TEMPLATE TAB ──────────────────────────────────────────── */}
          {activeTab === 'template' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase text-neutral-500 font-bold tracking-widest">
                  Extraction Fields
                </span>
                <button
                  onClick={() => addExtractionField({ label: '', selector: '', attribute: 'textContent' })}
                  className="flex items-center gap-1 px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-[10px] text-amber-400 rounded border border-neutral-700 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add Field
                </button>
              </div>

              {extractionTemplate.length === 0 ? (
                <div className="mt-6 text-center border border-dashed border-neutral-800 rounded-xl p-6">
                  <Tag className="w-8 h-8 mx-auto mb-2 text-neutral-700" />
                  <p className="text-xs text-neutral-500">
                    Define labeled fields to extract from each item
                  </p>
                  <p className="text-xs text-neutral-600 mt-2">
                    Example: title, price, description
                  </p>
                </div>
              ) : (
                extractionTemplate.map((field, idx) => (
                  <div
                    key={field.id}
                    className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-neutral-600 font-mono">
                        Field {idx + 1}
                      </span>
                      <button
                        onClick={() => removeExtractionField(field.id)}
                        className="text-neutral-600 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    <input
                      type="text"
                      placeholder="Label (e.g., title, price)"
                      value={field.label}
                      onChange={(e) => updateExtractionField(field.id, { label: e.target.value })}
                      className="w-full bg-neutral-950 border border-neutral-700 text-[11px] rounded
                        px-2 py-1.5 text-neutral-300 focus:outline-none focus:border-amber-500 placeholder-neutral-600"
                    />

                    <input
                      type="text"
                      placeholder="Selector (e.g., .title, h2)"
                      value={field.selector}
                      onChange={(e) => updateExtractionField(field.id, { selector: e.target.value })}
                      className="w-full bg-neutral-950 border border-neutral-700 text-[10px] rounded
                        px-2 py-1.5 text-neutral-300 focus:outline-none focus:border-amber-500 placeholder-neutral-600 font-mono"
                    />

                    <select
                      value={field.attribute}
                      onChange={(e) => updateExtractionField(field.id, { attribute: e.target.value as any })}
                      className="w-full bg-neutral-950 border border-neutral-700 text-[11px] rounded
                        px-2 py-1.5 text-neutral-300 focus:outline-none focus:border-amber-500 cursor-pointer"
                    >
                      <option value="textContent">Text Content</option>
                      <option value="value">Value (inputs)</option>
                      <option value="href">Link (href)</option>
                      <option value="src">Image (src)</option>
                      <option value="innerHTML">Inner HTML</option>
                    </select>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ─── DATA TAB ──────────────────────────────────────────────── */}
          {activeTab === 'data' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase text-neutral-500 font-bold tracking-widest">
                  Scraped Results
                </span>
                {scrapedData.length > 0 && (
                  <button
                    onClick={exportData}
                    className="flex items-center gap-1 px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-[10px] text-blue-400 rounded border border-neutral-700 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    Export JSON
                  </button>
                )}
              </div>

              {scrapedData.length === 0 ? (
                <div className="mt-6 text-center border border-dashed border-neutral-800 rounded-xl p-6">
                  <Table className="w-8 h-8 mx-auto mb-2 text-neutral-700" />
                  <p className="text-xs text-neutral-500">
                    No data yet. Click "Launch Scraper" to extract data.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {scrapedData.map((record, idx) => (
                    <div
                      key={idx}
                      className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 space-y-1.5"
                    >
                      <div className="text-[10px] text-neutral-600 font-mono mb-1">
                        Record {idx + 1}
                      </div>
                      {Object.entries(record).map(([key, value]) => (
                        <div key={key} className="flex gap-2">
                          <span className="text-[10px] text-amber-400 font-semibold shrink-0">
                            {key}:
                          </span>
                          <span className="text-[10px] text-neutral-300 truncate">
                            {String(value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
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
              📍 {currentUrl}
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
