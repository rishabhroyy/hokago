// Injected into every page load (atDocumentStart), before the SPA runs.
// Serves `window.hokagoNative`; storage reads come from the webview's own
// localStorage (written by the app), with write-through mirroring into the
// native secure store so a webview data wipe never kills a session.
// Downloads round-trip through native and resolve the returned promise.
(function () {
  if (window.__hokagoBridge || !window.webkit || !window.webkit.messageHandlers) return;
  window.__hokagoBridge = true;

  var CLIENT_KEY = "%CLIENT_KEY%";
  var APP_VERSION = "%APP_VERSION%";
  var APP_BUILD = "%APP_BUILD%";
  var SERVER_URL = "%SERVER_URL%";

  var pending = {};
  var nextId = 1;

  function send(msg) {
    try { window.webkit.messageHandlers.hokagoNative.postMessage(msg); } catch (e) {}
  }

  window.addEventListener("hokago-native", function (ev) {
    var d = ev.detail || {};
    if (d.type === "downloadResult") {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve({ localPath: d.localPath, sizeBytes: d.sizeBytes });
      else p.reject(new Error(d.error || "download failed"));
    } else if (d.type === "downloadListResult") {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      p.resolve(d.entries || []);
    } else if (d.type === "readTextResult") {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.text);
      else p.reject(new Error(d.error || "could not read subtitle"));
    } else if (d.type === "route") {
      // The SPA announces player/non-player routes so the shell can hide the
      // status bar + home indicator while watching.
      send({ type: "route", view: d.view || "" });
    }
  });

  function hydrate() {
    send({ type: "storageHydrate" });
  }

  window.hokagoNative = {
    platform: "ios",
    appVersion: APP_VERSION,
    appBuild: APP_BUILD,
    clientKey: CLIENT_KEY,
    serverUrl: SERVER_URL === "" ? null : SERVER_URL,
    storage: {
      get: function (k) {
        var v = localStorage.getItem(k);
        return v === null ? null : v;
      },
      set: function (k, v) {
        try { localStorage.setItem(k, v); } catch (e) {}
        send({ type: "storageSet", key: k, value: v });
      },
      delete: function (k) {
        try { localStorage.removeItem(k); } catch (e) {}
        send({ type: "storageDelete", key: k });
      }
    },
    downloads: {
      save: function (url, filename) {
        var id = nextId++;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          send({ type: "download", id: id, url: url, filename: filename });
        });
      },
      list: function () {
        var id = nextId++;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          send({ type: "downloadList", id: id });
        });
      },
      localUrl: function (localPath) {
        return "hokago-file://" + String(localPath).replace(/ /g, "%20");
      },
      readText: function (localPath) {
        var id = nextId++;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          send({ type: "readText", id: id, localPath: localPath });
        });
      },
      open: function (localPath) {
        send({ type: "open", localPath: localPath });
      }
    }
  };

  // Async hydration: native re-seeds localStorage for keys the keychain still
  // holds but the webview lost (wiped storage) — sessions survive.
  window.__hokagoHydrate = hydrate;
  document.addEventListener("DOMContentLoaded", function () { setTimeout(hydrate, 0); });
})();