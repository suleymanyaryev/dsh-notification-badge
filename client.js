/* dsh-notification-badge — client bundle (hand-written, matches the official
 * tsdown output shape, so no build step is needed).
 *
 * Browser half of dsh-notification-badge. It watches the client session status
 * projection and reacts on the machine VIEWING the Web UI — the right place
 * when the dsh server runs on a remote box, and the only place the app icon
 * can be reached from:
 *
 *   - a turn finishes                       → browser "Agent finished" popup
 *   - a session starts waiting on you       → browser "Waiting for you" popup
 *   - either, while the window is unfocused → attention badge on the app icon
 *
 * ## Why the session STATUS projection and not the session list
 *
 * `ctx.sessions.list` rows carry `running` but NOT `pendingInteraction`; their
 * shape is `{ id, displayTitle, running, retainedBy, blank, updatedAt,
 * formatStatus, … }` (see `projectList()` in
 * @deepseek-ai/dsh-api-session-controller). Pending interactions are projected
 * separately: `uiSession.sessionStatus` is a `Map<sessionId, { running,
 * pendingInteraction, completionUnread }>` — the same source the sidebar and
 * the composer read. A `pendingInteraction` is an object whose `kind` is the
 * documented discriminator ("approval" | "question" | "plan-review").
 *
 * `completionUnread` is deliberately NOT the badge trigger: it excludes the
 * session open in the main view, while the badge must still count a
 * main-session turn that finished while the window was hidden. The badge keeps
 * its own "needs attention since you last looked" set and clears it on focus.
 *
 * ## Badging API
 *
 * The Dock tile belongs to the Electron browser process, but the renderer can
 * ask it to update: Electron implements the standard Badging API
 * (shell/browser/badging/badge_manager.cc -> blink::mojom::BadgeService), so
 * no shell patch, IPC channel, or preload hook is needed. Two sharp edges:
 *
 *   - navigator.setAppBadge(0) is a protocol violation ("|value| should not be
 *     zero when it is |number|"). Chromium answers it with ReportBadMessage,
 *     which KILLS the renderer. Clearing always goes through clearAppBadge().
 *   - Values above 99 saturate to a localized "99+" (kMaxBadgeContent).
 *
 * ## Services and options
 *
 * `inject` stays empty on purpose: a top-level injection that is never
 * satisfied leaves the fiber PENDING, and the Web boot audit turns that into a
 * page-level failure ("N entries did not activate"). Waiting in a child fiber
 * instead keeps a missing service local to this plugin.
 *
 * Options are read from the host settings document, because the module system
 * creates every browser plugin entry with `{ name: id }` and no config
 * (`create()` in @deepseek-ai/dsh-client-modules) — a browser plugin never
 * receives row config. The host half declares its options `.volatile()`, and
 * this half reads them back through `ctx.configForms.get(<profile entry id>)`
 * (`describe()` in @deepseek-ai/dsh-settings serves the volatile fields of
 * active entries, keyed by entry id). The namespace is resolved lazily so the
 * settings client may arrive after this bundle, and the defaults below keep
 * everything working when it is not composed at all.
 */
window.__ModuleLoader__.load({
  id: "dsh-notification-badge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Deliberately empty — see the header. The services this plugin needs are
     * awaited in a child fiber inside `apply`, so a profile without them loses
     * the plugin's features instead of failing the whole page boot.
     */
    var inject = [];

    /**
     * Profile entry id this bundle inserts (see cordis.patch.yml). The host
     * settings document is keyed by entry id, so renaming the entry in a
     * profile patch means this constant must follow; an absent namespace
     * simply leaves the defaults below in place.
     */
    var ENTRY_ID = "notify-badge";

    var DEFAULT_TITLE = "DeepSeek Harness";
    var DEFAULT_MIN_TURN_MS = 5000;

    function noop() {}

    function canNotify() {
      return typeof Notification !== "undefined";
    }

    /** The Badging API, when this document has one. */
    function badgeApi() {
      if (typeof navigator === "undefined") return null;
      if (typeof navigator.setAppBadge !== "function") return null;
      if (typeof navigator.clearAppBadge !== "function") return null;
      return navigator;
    }

    /**
     * True inside the desktop shell, where an application icon exists. The
     * preload exposes `dshDesktop` in every `dsh-app:` frame, but only the main
     * frame receives the real bridge — the stub carries `protocolVersion`
     * alone, so test for a member only the bridge has.
     */
    function isDesktopShell() {
      if (typeof globalThis === "undefined") return false;
      var api = globalThis.dshDesktop;
      return api !== null && api !== undefined && typeof api.deviceInfo === "function";
    }

    /**
     * Ask for notification permission on the first user gesture (browsers
     * reject programmatic prompts without one). Returns a disposer; the
     * listeners are removed either when the gesture fires or when the plugin
     * is disposed, so a hot reload cannot stack pairs.
     */
    function requestPermissionOnGesture() {
      if (!canNotify() || Notification.permission !== "default") return noop;
      var done = false;
      function ask() {
        done = true;
        window.removeEventListener("pointerdown", ask, true);
        window.removeEventListener("keydown", ask, true);
        try { Notification.requestPermission().catch(noop); } catch (e) {}
      }
      window.addEventListener("pointerdown", ask, true);
      window.addEventListener("keydown", ask, true);
      return function () {
        if (done) return;
        window.removeEventListener("pointerdown", ask, true);
        window.removeEventListener("keydown", ask, true);
      };
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + "ms";
      var s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    /**
     * Human-readable reason a session is waiting on you. `interaction` is a
     * PendingApproval / PendingQuestion instance from the session status
     * projection; its `kind` is the documented discriminator, and an approval
     * also carries the requesting tool and the asker's reason.
     */
    function waitingText(interaction) {
      var kind = interaction && interaction.kind;
      if (kind === "approval") {
        var tool = interaction.toolName;
        return tool ? "Waiting for approval — " + tool : "Waiting for approval";
      }
      if (kind === "question") return "Waiting for your answer";
      if (kind === "plan-review") return "Waiting for plan review";
      return "Waiting for you";
    }

    /**
     * Collect option sources, weakest first: defaults are applied by
     * `normalize`, then any config the loader passed (kept for forward
     * compatibility), then the live host settings document.
     *
     * `snapshot` is returned alongside the values so the caller can tell
     * "this entry serves no such namespace" from "the document is still
     * loading" — a silent fallback to defaults is otherwise undiagnosable.
     */
    function optionSources(ctx, config) {
      var value = {};
      function absorb(source) {
        if (!source || typeof source !== "object") return;
        for (var key in source) {
          if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
          if (source[key] === undefined) continue;
          value[key] = source[key];
        }
      }
      absorb(config);
      var forms = ctx.get("configForms");
      var form = forms && typeof forms.get === "function" ? forms.get(ENTRY_ID) : null;
      var snapshot = null;
      if (form && typeof form.getSnapshot === "function") {
        snapshot = form.getSnapshot();
        if (snapshot) absorb(snapshot.value);
      }
      return { value: value, form: form, snapshot: snapshot };
    }

    function normalize(raw) {
      var v = raw && typeof raw === "object" ? raw : {};
      return {
        title: typeof v.title === "string" && v.title ? v.title : DEFAULT_TITLE,
        notifyOnIdle: v.notifyOnIdle !== false,
        notifyOnApproval: v.notifyOnApproval !== false,
        minTurnMs: typeof v.minTurnDurationMs === "number" ? v.minTurnDurationMs : DEFAULT_MIN_TURN_MS,
        browser: v.browser !== false,
        onlyWhenHidden: v.browserOnlyWhenHidden !== false,
        badge: v.badge !== false,
        badgeDesktopOnly: v.badgeDesktopOnly !== false,
        badgeMode: v.badgeMode === "dot" ? "dot" : "count",
        badgeMaxCount: typeof v.badgeMaxCount === "number" && v.badgeMaxCount > 0 ? Math.floor(v.badgeMaxCount) : 99,
        badgeOnIdle: v.badgeOnIdle !== false,
        badgeOnApproval: v.badgeOnApproval !== false,
        badgeClearOnFocus: v.badgeClearOnFocus !== false,
      };
    }

    function apply(ctx, config) {
      // Child fiber: wait for the services without ever leaving this plugin's
      // own fiber pending (which the Web boot audit reports as a page failure).
      ctx.inject(["sessions", "uiSession"], function (child) {
        var sessions = child.sessions;
        var status = child.uiSession.sessionStatus;
        if (!sessions || !sessions.list || !status) return;
        var list = sessions.list;

        var opts = normalize(optionSources(child, config).value);

        /* --- options ---------------------------------------------------- */

        var optionsUnsubscribe = null;
        var permissionDisposer = noop;
        // One diagnostic per page: a namespace the host never serves means the
        // profile row id and ENTRY_ID disagree, and every option silently
        // falls back to its default.
        var namespaceWarned = false;

        /** Ask for notification permission once, on the first user gesture. */
        function ensurePermission() {
          if (!opts.browser || !canNotify()) return;
          if (permissionDisposer !== noop) return;
          permissionDisposer = requestPermissionOnGesture();
        }

        /** Re-read the live settings document; subscribe on first success. */
        function refreshOptions() {
          var sources = optionSources(child, config);
          opts = normalize(sources.value);
          if (!namespaceWarned && sources.snapshot && sources.snapshot.status === "unavailable") {
            namespaceWarned = true;
            var message = 'dsh-notification-badge: settings namespace "' + ENTRY_ID
              + '" is not served; every option falls back to its default. Check that the profile row id matches ENTRY_ID in client.js.';
            // The logger is the framework channel, but the Web composition
            // registers no exporter for it, so the console is the sink that is
            // actually visible when this misconfiguration happens.
            try { child.logger.warn(message); } catch (e) {}
            if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
          }
          if (!optionsUnsubscribe && sources.form && typeof sources.form.subscribe === "function") {
            optionsUnsubscribe = sources.form.subscribe(function () {
              refreshOptions();
              render();
            });
          }
          ensurePermission();
          return opts;
        }
        refreshOptions();

        /** True while the user is actually looking at this window. */
        function attended() {
          try {
            return document.visibilityState === "visible" && document.hasFocus();
          } catch (e) {
            return true;
          }
        }

        /* --- browser notifications -------------------------------------- */

        function show(body) {
          if (!opts.browser || !canNotify()) return;
          if (Notification.permission !== "granted") return;
          // A visible window that does not have focus is exactly when a popup
          // is wanted; only a window you are actually looking at is quiet.
          if (opts.onlyWhenHidden && attended()) return;
          try {
            var n = new Notification(opts.title, { body: body, tag: "dsh-notification-badge" });
            n.onclick = function () {
              try { window.focus(); } catch (e) {}
              n.close();
            };
          } catch (e) {}
        }

        /* --- app-icon badge --------------------------------------------- */

        var api = badgeApi();
        // sessionId -> true for every session that wants attention and has not
        // been looked at yet.
        var attention = Object.create(null);
        // Last value handed to the Badging API, so redundant calls are dropped.
        var applied;

        function badgeActive() {
          if (!api || !opts.badge) return false;
          if (!opts.badgeDesktopOnly) return true;
          return isDesktopShell();
        }

        function settle(promise) {
          if (promise && typeof promise.then === "function") {
            promise.then(noop, function () { applied = undefined; }); // e.g. NotAllowedError: retry later
          }
        }

        /**
         * Push one badge state. `0` means "clear" and always goes through
         * clearAppBadge() — setAppBadge(0) would kill the renderer.
         */
        function write(value) {
          if (applied === value) return;
          applied = value;
          try {
            if (value === "dot") settle(api.setAppBadge());
            else if (value > 0) settle(api.setAppBadge(value));
            else settle(api.clearAppBadge());
          } catch (e) {
            applied = undefined;
          }
        }

        function count() {
          var n = 0;
          for (var id in attention) n++;
          return n;
        }

        function render() {
          if (!badgeActive()) {
            // Feature off (or not in the desktop shell): never leave a stale
            // badge behind, but never touch the API when nothing was set.
            if (applied !== undefined) write(0);
            return;
          }
          var n = count();
          if (opts.badgeMode === "dot") write(n > 0 ? "dot" : 0);
          else write(n > 0 ? Math.min(n, opts.badgeMaxCount) : 0);
        }

        function mark(id) {
          if (attention[id]) return false;
          attention[id] = true;
          return true;
        }

        function forget(id) {
          if (!attention[id]) return false;
          delete attention[id];
          return true;
        }

        /* --- session status watch --------------------------------------- */

        /**
         * Whether this session is a known, non-subagent session. The session
         * list is the only client-side place `origin` is published, so a
         * session the list has not delivered yet is UNKNOWN: acting on it would
         * ping you for a subagent's turn, so unknown sessions stay untracked
         * and are adopted once the list names them (`adoptKnown`).
         */
        function isNotifiable(id) {
          var byId = list.getSnapshot().byId;
          if (!Object.prototype.hasOwnProperty.call(byId, id)) return false;
          var row = byId[id];
          return row !== undefined && row.origin !== "subagent";
        }

        // sessionId -> { running, pending, runningSince }: the previous state
        // the next snapshot is diffed against.
        var prev = new Map();

        function rowState(row) {
          return { running: row.running === true, pending: row.pendingInteraction, runningSince: 0 };
        }

        /**
         * Track every session the status projection already knows and the list
         * can now classify, without announcing anything: this is the (re)seed
         * path, so a run already in flight keeps `runningSince: 0` and notifies
         * without a duration. A session already waiting for you counts too —
         * unless you are looking at the app right now.
         */
        function adoptKnown() {
          var snapshot = status.getSnapshot();
          var away = !attended();
          var dirty = false;
          snapshot.forEach(function (row, id) {
            if (prev.has(id) || !isNotifiable(id)) return;
            prev.set(id, rowState(row));
            if (away && opts.badgeOnApproval && row.pendingInteraction != null && mark(id)) dirty = true;
          });
          if (dirty) render();
        }

        // The settings client may be provided after this fiber activates. A
        // nested optional child re-reads the document the moment it arrives, so
        // activation order can never leave the options at their defaults. It is
        // registered here, once the badge state below exists, because an
        // already-provided service may run the callback immediately.
        child.inject(["configForms"], function () {
          refreshOptions();
          render();
        });

        function seed() {
          adoptKnown();
          render();
        }
        seed();

        // The list loads asynchronously: sessions the status projection already
        // reports stay untracked until it can say whether they are subagents.
        // This second seed runs the moment it can, so an already-waiting
        // session still badges while a subagent never does.
        var listUnsubscribe = list.subscribe(function () {
          if (list.getSnapshot().phase !== "ready") return;
          adoptKnown();
        });

        function observe() {
          refreshOptions();
          var snapshot = status.getSnapshot();
          var dirty = false;
          var seen = Object.create(null);
          snapshot.forEach(function (row, id) {
            seen[id] = true;
            if (!isNotifiable(id)) return;
            var p = prev.get(id);
            if (p === undefined) {
              // A session that appeared while we were watching: adopt the
              // state silently, but remember a run already in flight.
              var adopted = rowState(row);
              if (adopted.running) adopted.runningSince = Date.now();
              prev.set(id, adopted);
              return;
            }
            // Track when a run started so short turns stay quiet, mirroring
            // the host side's minTurnDurationMs gate.
            if (!p.running && row.running === true) p.runningSince = Date.now();

            // Started waiting on you: pendingInteraction appeared.
            var waiting = p.pending == null && row.pendingInteraction != null;
            // Turn finished: running flipped off with nothing pending.
            var finished = p.running && row.running !== true && row.pendingInteraction == null;
            var elapsed = null;
            if (finished) {
              elapsed = p.runningSince ? Date.now() - p.runningSince : null;
              if (elapsed !== null && elapsed < opts.minTurnMs) finished = false;
            }

            p.pending = row.pendingInteraction;
            p.running = row.running === true;

            if (waiting && opts.notifyOnApproval) show(waitingText(row.pendingInteraction));
            // A turn we never saw start (the UI opened mid-turn) still
            // notifies, just without a duration: only the minimum-duration
            // gate needs a measured start.
            if (finished && opts.notifyOnIdle) {
              show(elapsed === null ? "Agent finished" : "Agent finished — " + formatDuration(elapsed));
            }

            // Only accumulate while you are elsewhere: a focused window already
            // shows the turn finishing, and a badge there is just noise.
            var wants = (waiting && opts.badgeOnApproval) || (finished && opts.badgeOnIdle);
            if (wants && !attended() && mark(id)) dirty = true;
          });
          // Sessions that left the list stop wanting attention.
          prev.forEach(function (_state, id) {
            if (seen[id]) return;
            prev.delete(id);
            if (forget(id)) dirty = true;
          });
          if (dirty) render();
        }

        var unsubscribe = status.subscribe(observe);

        function attend() {
          if (!opts.badgeClearOnFocus) return;
          var dirty = false;
          for (var id in attention) {
            delete attention[id];
            dirty = true;
          }
          if (dirty) render();
        }

        function onVisibility() {
          if (document.visibilityState === "visible") attend();
        }

        window.addEventListener("focus", attend);
        document.addEventListener("visibilitychange", onVisibility);

        child.effect(function () {
          return function () {
            unsubscribe();
            listUnsubscribe();
            if (optionsUnsubscribe) optionsUnsubscribe();
            permissionDisposer();
            window.removeEventListener("focus", attend);
            document.removeEventListener("visibilitychange", onVisibility);
            write(0); // never leave a stale badge behind
          };
        }, "dsh-notification-badge: session watch and badge lifecycle");
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
