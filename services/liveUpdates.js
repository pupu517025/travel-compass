(() => {
  if (!window.CloudEvents?.isConfigured() || typeof refreshAfterModeration !== 'function') return;
  let refreshWhenVisible = false;
  window.CloudEvents.subscribePublicUpdates(() => {
    if (document.visibilityState === 'visible') refreshAfterModeration();
    else refreshWhenVisible = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && refreshWhenVisible) {
      refreshWhenVisible = false;
      refreshAfterModeration();
    }
  });
})();
