/**
 * A stand-in for YouTube's `ytgame` SDK, served by `vg distribute youtube --preview` in
 * place of the real script. The real one only runs inside YouTube, and
 * YouTube's own test suite only runs a release already uploaded to its portal,
 * so without this an integration cannot be tried before an invite.
 *
 * It records every call, flags the ordering YouTube requires, and takes pause,
 * resume and audio commands from the preview page through postMessage. Plain
 * JavaScript, because the browser runs it as written.
 */
export const YTGAME_STUB = String.raw`(() => {
  const log = { calls: [], errors: [], save: null };
  const listeners = { pause: [], resume: [], audio: [] };
  let audio = true;
  let firstFrame = false;
  const report = () => parent.postMessage({ type: "vg-ytgame-log", log }, "*");
  const record = (name, detail) => {
    log.calls.push(detail === undefined ? name : name + " " + JSON.stringify(detail));
    report();
  };
  const fail = (message) => {
    log.errors.push(message);
    report();
  };
  const subscribe = (kind, name) => (callback) => {
    record(name);
    listeners[kind].push(callback);
    return () => {
      listeners[kind] = listeners[kind].filter((c) => c !== callback);
    };
  };
  let loaded = false;
  window.__ytgameStub = log;
  window.ytgame = {
    IN_PLAYABLES_ENV: true,
    SDK_VERSION: "vg-preview-stub",
    ads: {
      requestInterstitialAd: () => (record("ads.requestInterstitialAd"), Promise.resolve()),
      requestRewardedAd: (id) => (record("ads.requestRewardedAd", id), Promise.resolve(true)),
    },
    engagement: {
      sendScore: (score) => (record("engagement.sendScore", score), Promise.resolve()),
    },
    game: {
      firstFrameReady: () => {
        if (firstFrame) fail("firstFrameReady called more than once");
        firstFrame = true;
        record("game.firstFrameReady");
      },
      gameReady: () => {
        if (!firstFrame) fail("gameReady called before firstFrameReady");
        record("game.gameReady");
      },
      loadData: () => {
        loaded = true;
        record("game.loadData");
        return Promise.resolve(log.save ?? "");
      },
      saveData: (data) => {
        if (!loaded) fail("saveData called before loadData resolved");
        if (data.length * 2 > 3 * 1024 * 1024) fail("saveData over 3 MiB");
        log.save = data;
        record("game.saveData", data.length + " chars");
        return Promise.resolve();
      },
    },
    health: {
      logError: () => record("health.logError"),
      logWarning: () => record("health.logWarning"),
    },
    system: {
      getLanguage: () => (record("system.getLanguage"), Promise.resolve("en")),
      isAudioEnabled: () => (record("system.isAudioEnabled"), audio),
      onAudioEnabledChange: subscribe("audio", "system.onAudioEnabledChange"),
      onPause: subscribe("pause", "system.onPause"),
      onResume: subscribe("resume", "system.onResume"),
    },
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== "vg-ytgame") return;
    if (data.action === "pause") listeners.pause.forEach((c) => c());
    if (data.action === "resume") listeners.resume.forEach((c) => c());
    if (data.action === "audio") {
      audio = Boolean(data.enabled);
      listeners.audio.forEach((c) => c(audio));
    }
    record("preview." + data.action, data.action === "audio" ? audio : undefined);
  });
  addEventListener("error", (event) => fail("page error: " + event.message));
  addEventListener("securitypolicyviolation", (event) =>
    fail("blocked by the portal's CSP: " + event.violatedDirective + " " + event.blockedURI),
  );
})();
`;
