// ==UserScript==
// @name         Block Redirects, Popups, and External Tab Opening
// @namespace    https://github.com/dripnodrizzle/Tampermonkey
// @version      1.3.0
// @description  Blocks page redirects, popups, and tab opening to other sites when clicking on the screen
// @author       dripnodrizzle
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const currentOrigin = window.location.origin;

    // ── Shared helper ─────────────────────────────────────────────────────────
    function isExternalUrl(url) {
        if (!url) return false;
        try {
            const dest = new URL(String(url), window.location.href);
            return dest.origin !== currentOrigin;
        } catch (e) {
            return true; // treat invalid/malformed URLs as external
        }
    }

    // ── 1. Block window.open (popups and new tabs) ────────────────────────────
    // Use Object.defineProperty so page scripts that run later cannot overwrite
    // our override.
    const _windowOpen = window.open.bind(window);
    const _blockedOpen = function (url, target, features) {
        if (!url) return null;
        if (isExternalUrl(url)) {
            console.warn('[BlockScript] Blocked window.open to external URL:', url);
            return null;
        }
        return _windowOpen(url, target, features);
    };
    try {
        Object.defineProperty(window, 'open', {
            value: _blockedOpen,
            writable: false,
            configurable: false
        });
    } catch (e) {
        window.open = _blockedOpen;
    }

    // ── 2. Block external redirects via window.location ──────────────────────
    // `window.location` is non-configurable in all modern browsers, so a Proxy
    // over it will silently fail.  Instead, patch Location.prototype directly:
    // override the `href` setter and the `assign`/`replace` methods.
    (function blockLocationRedirects() {
        // --- href setter ---
        const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (hrefDesc && hrefDesc.set) {
            const nativeSet = hrefDesc.set;
            Object.defineProperty(Location.prototype, 'href', {
                get: hrefDesc.get,
                set(url) {
                    if (isExternalUrl(url)) {
                        console.warn('[BlockScript] Blocked location.href redirect to:', url);
                        return;
                    }
                    nativeSet.call(this, url);
                },
                enumerable: hrefDesc.enumerable,
                configurable: true
            });
        }

        // --- assign() and replace() ---
        ['assign', 'replace'].forEach(function (method) {
            const native = Location.prototype[method];
            if (typeof native !== 'function') return;
            Object.defineProperty(Location.prototype, method, {
                value: function (url) {
                    if (isExternalUrl(url)) {
                        console.warn('[BlockScript] Blocked location.' + method + '() to:', url);
                        return;
                    }
                    native.call(this, url);
                },
                writable: true,
                configurable: true,
                enumerable: Location.prototype.propertyIsEnumerable(method)
            });
        });
    })();

    // ── 3. Block meta-refresh redirects ──────────────────────────────────────
    function blockMetaRefresh() {
        document.querySelectorAll('meta[http-equiv="refresh"]').forEach(meta => {
            const content = meta.getAttribute('content') || '';
            // content is "seconds; URL=..."
            const match = content.match(/url=(.+)/i);
            if (match) {
                try {
                    const dest = new URL(match[1].trim(), window.location.href);
                    if (dest.origin !== currentOrigin) {
                        meta.remove();
                        console.warn('[BlockScript] Removed meta-refresh redirect to:', match[1].trim());
                    }
                } catch (e) {
                    meta.remove(); // malformed – remove to be safe
                }
            }
        });
    }

    // Run immediately and observe future DOM changes
    if (document.readyState !== 'loading') {
        blockMetaRefresh();
    } else {
        document.addEventListener('DOMContentLoaded', blockMetaRefresh);
    }

    const metaObserver = new MutationObserver(blockMetaRefresh);
    document.addEventListener('DOMContentLoaded', () => {
        metaObserver.observe(document.head || document, { childList: true, subtree: true });
    });

    // ── 4. Block clicks that open external URLs or new tabs ──────────────────
    function getAnchorFromTarget(target) {
        // Walk up the DOM tree to find the nearest <a> ancestor
        let el = target;
        while (el && el !== document.body) {
            if (el.tagName === 'A') return el;
            el = el.parentElement;
        }
        return null;
    }

    document.addEventListener('click', function (e) {
        const anchor = getAnchorFromTarget(e.target);
        if (!anchor) return;

        const href = anchor.getAttribute('href');
        const targetAttr = (anchor.getAttribute('target') || '').toLowerCase();

        // Block links that open in a new tab/window and go to an external site
        if (targetAttr === '_blank' || targetAttr === '_new') {
            if (isExternalUrl(href)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                console.warn('[BlockScript] Blocked external link click (new tab):', href);
                return;
            }
        }

        // Block any click that would navigate to an external URL in the same tab
        if (href && isExternalUrl(href)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.warn('[BlockScript] Blocked external link click:', href);
        }
    }, true /* capture phase – fires before the page's own handlers */);

    // ── 5. Block form submissions to external targets ─────────────────────────
    document.addEventListener('submit', function (e) {
        const form = e.target;
        if (!form || form.tagName !== 'FORM') return;

        const action = form.getAttribute('action') || window.location.href;
        if (isExternalUrl(action)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.warn('[BlockScript] Blocked form submission to external URL:', action);
        }
    }, true);

    // ── 6. Intercept history.pushState / replaceState before 3rd-party scripts ─
    // The "culprit" analytics script (Cloudflare beacon) wraps history.pushState
    // to track SPA navigation.  By wrapping it ourselves first (we run at
    // document-start, before any page script), our layer is the innermost one.
    // This also lets us log any unusual URL patterns pushed into history.
    (function patchHistory() {
        ['pushState', 'replaceState'].forEach(function (method) {
            const native = history[method];
            if (typeof native !== 'function') return;
            history[method] = function (state, title, url) {
                if (url !== undefined && url !== null && isExternalUrl(String(url))) {
                    console.warn('[BlockScript] Blocked history.' + method + '() to external-like URL:', url);
                    return;
                }
                return native.apply(this, arguments);
            };
        });
    })();

    // ── 7. Block culprit <script id="*override*"> and neutralize override elems ─
    // The culprit analytics script is injected via a <script> whose id contains
    // "override".  Removing it the instant it appears in the DOM prevents it from
    // running (works for defer/async scripts and dynamically-injected ones).
    // For non-script elements with "override" in their id we strip onclick and
    // block clicks so they cannot trigger external redirects.

    function neutralizeOverrideEl(el) {
        if (el.nodeType !== 1) return;
        if (!el.id || !/override/i.test(el.id)) return;

        if (el.tagName === 'SCRIPT') {
            el.remove();
            console.warn('[BlockScript] Removed culprit script (override id):', el.id);
            return;
        }

        // Strip inline onclick that could trigger a redirect
        if (el.getAttribute('onclick')) {
            el.removeAttribute('onclick');
        }
        // Strip external href on anchor tags
        if (el.tagName === 'A') {
            const href = el.getAttribute('href');
            if (href && isExternalUrl(href)) {
                el.removeAttribute('href');
            }
        }
        // Prevent any remaining click on this element from propagating
        el.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.warn('[BlockScript] Blocked click on override element:', el.id);
        }, true);
    }

    function neutralizeOverrideElements(root) {
        const context = root || document;
        Array.from(context.querySelectorAll('[id]')).filter(function (el) {
            return /override/i.test(el.id);
        }).forEach(neutralizeOverrideEl);
    }

    // MutationObserver active from document-start so it catches every inserted node
    const overrideObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(function (node) {
                if (node.nodeType !== 1) return;
                neutralizeOverrideEl(node);
                // Also scan inside the subtree that was added
                if (typeof node.querySelectorAll === 'function') {
                    neutralizeOverrideElements(node);
                }
            });
        });
    });

    overrideObserver.observe(document.documentElement || document.body || document, {
        childList: true,
        subtree: true
    });

    // Scan elements that are already present (e.g. if readyState is not 'loading')
    if (document.readyState !== 'loading') {
        neutralizeOverrideElements();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            neutralizeOverrideElements();
        });
    }

    console.info('[BlockScript] Block Redirects, Popups, and External Tab Opening – active on', currentOrigin);
})();
