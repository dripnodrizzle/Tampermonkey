// ==UserScript==
// @name         Block Redirects, Popups, and External Tab Opening
// @namespace    https://github.com/dripnodrizzle/Tampermonkey
// @version      1.0.0
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
    const _windowOpen = window.open.bind(window);
    window.open = function (url, target, features) {
        if (!url) return null;
        if (isExternalUrl(url)) {
            console.warn('[BlockScript] Blocked window.open to external URL:', url);
            return null;
        }
        return _windowOpen(url, target, features);
    };

    // ── 2. Block external redirects via window.location ──────────────────────
    // We proxy the `location` object so that assigning `window.location.href`
    // to an external URL is caught and cancelled.
    (function blockLocationRedirects() {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'location');
        // `location` is typically non-configurable on some browsers; guard accordingly
        if (!descriptor || !descriptor.configurable) return;

        const _location = window.location;

        const locationProxy = new Proxy(_location, {
            set(target, prop, value) {
                if (prop === 'href' && isExternalUrl(value)) {
                    console.warn('[BlockScript] Blocked location redirect to:', value);
                    return true; // silently ignore
                }
                target[prop] = value;
                return true;
            },
            get(target, prop) {
                if (prop === 'assign' || prop === 'replace') {
                    return function (url) {
                        if (isExternalUrl(url)) {
                            console.warn('[BlockScript] Blocked location.' + prop + '() to:', url);
                            return;
                        }
                        target[prop](url);
                    };
                }
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
            }
        });

        try {
            Object.defineProperty(window, 'location', {
                get() { return locationProxy; },
                configurable: true
            });
        } catch (e) {
            // If we can't redefine location, fall through – click-based blocking
            // (step 4) will still cover the common cases.
        }
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

    console.info('[BlockScript] Block Redirects, Popups, and External Tab Opening – active on', currentOrigin);
})();
