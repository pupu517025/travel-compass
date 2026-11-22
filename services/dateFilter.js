(() => {
  const input = document.getElementById('visitDate');
  if (!input || typeof state === 'undefined' || typeof search !== 'function') return;
  input.min = date(0);
  input.value = state.visitDate;
  input.addEventListener('change', () => {
    if (!input.value) return;
    state.visitDate = input.value;
    if (state.mode !== 'overview') search();
  });
})();
