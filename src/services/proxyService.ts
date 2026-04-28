import { Page } from 'playwright';

// This script runs inside the iframe in the user's browser.
// `window.parent.postMessage` sends events back to the React app.
const INJECTION_SCRIPT = `
<style id="__ag_styles">
  .ag-hover {
    outline: 2px solid rgba(16, 185, 129, 0.9) !important;
    outline-offset: 2px;
    background-color: rgba(16, 185, 129, 0.07) !important;
    cursor: pointer !important;
  }
</style>
<script id="__ag_script">
(function() {
  if (window.__agReady) return;
  window.__agReady = true;

  /* ---------- Selector builder ---------- */
  function esc(v) {
    return String(v || '').replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
  }

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  }

  function buildAttrSelector(tag, attr, value) {
    if (!value) return '';
    return tag + '[' + attr + '="' + esc(value) + '"]';
  }

  function stableAnchorSelector(el) {
    if (!el || !el.getAttribute) return '';
    var href = el.getAttribute('href') || '';
    if (!href || href === '#' || href.indexOf('javascript:') === 0) return '';
    var byHref = 'a[href="' + esc(href) + '"]';
    if (unique(byHref)) return byHref;
    var parent = el.parentElement;
    if (parent) {
      var psel = buildGeneralSelector(parent);
      if (psel) {
        var combined = psel + ' ' + byHref;
        if (unique(combined)) return combined;
      }
    }
    return byHref;
  }

  function stableAnchorTextSelector(el) {
    if (!el || !el.innerText) return '';
    var txt = el.innerText.trim().replace(/\\s+/g, ' ');
    if (!txt) return '';
    // Keep selector short and stable; Playwright supports :has-text().
    var snippet = txt.substring(0, 60);
    var escaped = esc(snippet);
    var byText = 'a:has-text("' + escaped + '")';
    if (unique(byText)) return byText;
    var parent = el.parentElement;
    if (parent) {
      var psel = buildGeneralSelector(parent);
      if (psel) return psel + ' ' + byText;
    }
    return byText;
  }

  function getSelector(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') {
      var linkSel = stableAnchorSelector(el);
      if (linkSel) return linkSel;
      var textLinkSel = stableAnchorTextSelector(el);
      if (textLinkSel) return textLinkSel;
    }

    var id = el.getAttribute && el.getAttribute('id');
    if (id) {
      var byId = buildAttrSelector(tag, 'id', id);
      if (unique(byId)) return byId;
    }

    // Prefer stable semantic/test attributes before class chains.
    var preferredAttrs = [
      'name', 'data-testid', 'data-testid', 'data-test',
      'data-qa', 'data-cy', 'aria-label', 'placeholder',
      'title', 'key'
    ];
    for (var ai = 0; ai < preferredAttrs.length; ai++) {
      var attr = preferredAttrs[ai];
      var val = el.getAttribute && el.getAttribute(attr);
      if (val) {
        var sel = buildAttrSelector(tag, attr, val);
        if (unique(sel)) return sel;
      }
    }

    var name = el.getAttribute && el.getAttribute('name');
    if (name) {
      var byName = buildAttrSelector(tag, 'name', name);
      if (unique(byName)) return byName;
      return byName;
    }

    var type = el.getAttribute && el.getAttribute('type');
    if (type && tag === 'input') {
      var byType = buildAttrSelector(tag, 'type', type);
      if (unique(byType)) return byType;
    }

    if (el.className && typeof el.className === 'string') {
      var parts = el.className.split(' ').filter(function(c) {
        return c.length > 0 && c !== 'ag-hover';
      }).slice(0, 3);
      if (parts.length) return tag + '.' + parts.join('.');
    }
    if (tag === 'a') {
      var parent = el.parentElement;
      if (parent) {
        var anchors = parent.querySelectorAll('a');
        if (anchors.length > 1) {
          var idx = 1;
          for (var i = 0; i < anchors.length; i++) {
            if (anchors[i] === el) {
              idx = i + 1;
              break;
            }
          }
          return 'a:nth-of-type(' + idx + ')';
        }
      }
      return 'a[href]';
    }
    return tag;
  }

  function buildGeneralSelector(el) {
    if (!el || !el.tagName) return '';
    var tag = el.tagName.toLowerCase();
    if (el.id) return tag + '#' + el.id;
    var dataCase = el.getAttribute && el.getAttribute('data-case-id');
    if (dataCase) return tag + '[data-case-id]';
    if (el.className && typeof el.className === 'string') {
      var parts = el.className.split(' ').filter(function(c) {
        return c.length > 0 && c !== 'ag-hover' && !/[0-9]{4,}/.test(c);
      }).slice(0, 2);
      if (parts.length) return tag + '.' + parts.join('.');
    }
    return tag;
  }

  function findRepeatedAncestor(el) {
    var cur = el;
    for (var depth = 0; depth < 8; depth++) {
      if (!cur || !cur.parentElement) break;
      var parent = cur.parentElement;
      var sig = buildGeneralSelector(cur);
      if (!sig) break;
      try {
        var count = parent.querySelectorAll(':scope > ' + sig).length;
        if (count >= 2) {
          return cur;
        }
      } catch (_) {}
      cur = parent;
    }
    return null;
  }

  function guessLoopHint(el) {
    var card = findRepeatedAncestor(el);
    if (!card) return null;
    var itemSelector = buildGeneralSelector(card);
    var container = card.parentElement;
    var containerSelector = container ? buildGeneralSelector(container) : 'body';
    if (!itemSelector) return null;
    return {
      itemSelector: itemSelector,
      containerSelector: containerSelector || 'body'
    };
  }

  /* ---------- Resolve href for any click (walk up to <a>) ---------- */
  function resolveHref(el) {
    var cur = el;
    for (var i = 0; i < 6; i++) {
      if (!cur || !cur.tagName) break;
      if (cur.tagName.toUpperCase() === 'A') {
        return cur.getAttribute('href') || cur.href || '';
      }
      cur = cur.parentElement;
    }
    return '';
  }

  /* ---------- Is this a navigation click? ---------- */
  function isNavClick(el, href) {
    var tag = el.tagName.toUpperCase();
    // Real link (not anchor / javascript:)
    if (href && href.length > 0 && href !== '#' &&
        href.indexOf('javascript:') !== 0 && href.indexOf('#') !== 0) {
      return true;
    }
    // Submit buttons / inputs
    if (tag === 'BUTTON' || tag === 'INPUT') {
      var btype = (el.getAttribute('type') || 'submit').toLowerCase();
      if (btype === 'submit') return !!el.closest('form');
    }
    return false;
  }

  /* ---------- Hover ---------- */
  document.addEventListener('mouseover', function(e) {
    if (e.target && e.target.classList) e.target.classList.add('ag-hover');
  }, true);
  document.addEventListener('mouseout', function(e) {
    if (e.target && e.target.classList) e.target.classList.remove('ag-hover');
  }, true);

  /* ---------- Click ---------- */
  document.addEventListener('click', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;

    // Capture selector from the nearest actionable ancestor so clicks on nested
    // spans/icons produce stable selectors for actual interactive elements.
    var actionEl = el.closest('a,button,input,textarea,select,[role="button"],[onclick],[data-testid],[name]') || el;

    var tag     = actionEl.tagName.toLowerCase();
    var sel     = getSelector(actionEl);
    var txt     = actionEl.innerText ? actionEl.innerText.trim().substring(0, 120) : '';
    var val     = actionEl.value || '';
    var href    = resolveHref(actionEl);
    var isInput = ['input', 'textarea', 'select'].indexOf(tag) !== -1;
    var nav     = !isInput && isNavClick(actionEl, href);

    if (nav) {
      /* Stop the page from navigating itself — backend handles it */
      e.preventDefault();
      e.stopPropagation();
    }

    window.parent.postMessage({
      type:    'USER_CLICKED_ELEMENT',
      selector: sel,
      tagName: tag,
      text:    txt,
      value:   val,
      href:    href,
      isNav:   nav,
      isInput: isInput,
      loopHint: guessLoopHint(actionEl)
    }, '*');
  }, true);

  /* ---------- Input / typing ---------- */
  document.addEventListener('input', function(e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    window.parent.postMessage({
      type:     'USER_INPUT_CHANGE',
      selector: getSelector(el),
      tagName:  el.tagName.toLowerCase(),
      value:    el.value || ''
    }, '*');
  }, true);

  console.log('[AgScraper] Ready.');
})();
</script>
`;

/**
 * Build the proxied HTML:
 *  1. Get page.content() from Playwright
 *  2. Rewrite relative paths → absolute
 *  3. STRIP all site <script> tags — prevents the site's own JS (auth checks,
 *     React SPAs, etc.) from running in the iframe and causing redirects.
 *  4. Inject our lightweight click-recorder script instead
 */
export const getProxiedHtml = async (page: Page, pageUrl: string): Promise<string> => {
  let html = await page.content();

  // Rewrite root-relative paths → absolute
  try {
    const origin = new URL(pageUrl).origin;
    html = html.replace(/(src|href)=["']\/(?!\/)([^"']*?)["']/g, `$1="${origin}/$2"`);
  } catch (_) { /* ignore unparseable URLs */ }

  // ── KEY FIX: strip ALL site script tags ──────────────────────────────────
  // The site's JS runs in the iframe WITHOUT the auth cookies that Playwright
  // holds.  Auth-checking code then redirects the iframe to the login page.
  // We strip scripts so only our injection script runs.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove any stale injection from a previous snapshot
  html = html.replace(/<style id="__ag_styles">[\s\S]*?<\/style>/i, '');
  html = html.replace(/<script id="__ag_script">[\s\S]*?<\/script>/i, '');

  // Inject before </body> (or at the end as fallback)
  if (html.includes('</body>')) {
    html = html.replace('</body>', INJECTION_SCRIPT + '\n</body>');
  } else {
    html += INJECTION_SCRIPT;
  }

  return html;
};
