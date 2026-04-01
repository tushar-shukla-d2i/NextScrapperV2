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
  function getSelector(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id) return tag + '#' + el.id;
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return tag + '[name="' + name + '"]';
    var type = el.getAttribute && el.getAttribute('type');
    if (type && tag === 'input') return tag + '[type="' + type + '"]';
    if (el.className && typeof el.className === 'string') {
      var parts = el.className.split(' ').filter(function(c) {
        return c.length > 0 && c !== 'ag-hover';
      }).slice(0, 3);
      if (parts.length) return tag + '.' + parts.join('.');
    }
    return tag;
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

    var tag     = el.tagName.toLowerCase();
    var sel     = getSelector(el);
    var txt     = el.innerText ? el.innerText.trim().substring(0, 120) : '';
    var val     = el.value || '';
    var href    = resolveHref(el);
    var isInput = ['input', 'textarea', 'select'].indexOf(tag) !== -1;
    var nav     = !isInput && isNavClick(el, href);

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
      isInput: isInput
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
