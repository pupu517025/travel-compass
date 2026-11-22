(function (global) {
  const hash = new URLSearchParams(global.location.hash.replace(/^#/, ''));
  const flow = hash.get('type');
  if (!['invite', 'recovery'].includes(flow)) return;

  const escape = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const panel = document.createElement('section');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'authSetupTitle');
  panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#17332ccc;display:grid;place-items:center;padding:20px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
  panel.innerHTML = `
    <div style="width:min(100%,440px);background:#fff;border-radius:18px;padding:26px;box-shadow:0 20px 70px #0004;color:#17332c">
      <h1 id="authSetupTitle" style="font-size:22px;margin:0 0 8px">設定管理者密碼</h1>
      <p style="margin:0 0 18px;color:#64756d;line-height:1.55">請設定一組新的密碼，之後用此密碼登入活動管理頁。</p>
      <form id="authSetupForm" style="display:grid;gap:12px">
        <label style="display:grid;gap:6px">新密碼<input id="authSetupPassword" type="password" autocomplete="new-password" minlength="8" required style="font:inherit;padding:11px;border:1px solid #cbd8cf;border-radius:9px"></label>
        <label style="display:grid;gap:6px">再次輸入新密碼<input id="authSetupConfirm" type="password" autocomplete="new-password" minlength="8" required style="font:inherit;padding:11px;border:1px solid #cbd8cf;border-radius:9px"></label>
        <button id="authSetupSubmit" type="submit" style="font:inherit;font-weight:700;padding:12px;border:0;border-radius:9px;background:#174f3d;color:white;cursor:pointer">儲存密碼</button>
      </form>
      <p id="authSetupMessage" role="status" style="margin:12px 0 0;color:#52665d;line-height:1.5"></p>
      <a id="authSetupAdminLink" href="admin.html" hidden style="display:inline-block;margin-top:12px;color:#176b4c;font-weight:700">前往活動管理頁 →</a>
    </div>`;
  document.body.append(panel);

  const message = panel.querySelector('#authSetupMessage');
  const form = panel.querySelector('#authSetupForm');
  const submit = panel.querySelector('#authSetupSubmit');
  const setMessage = (text, error = false) => {
    message.textContent = text;
    message.style.color = error ? '#a14832' : '#52665d';
  };
  const params = new URLSearchParams(global.location.search);
  const authError = params.get('error_description') || hash.get('error_description');
  if (authError) setMessage(`連結無法使用：${authError.replaceAll('+', ' ')}`, true);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const password = panel.querySelector('#authSetupPassword').value;
    const confirm = panel.querySelector('#authSetupConfirm').value;
    if (password !== confirm) return setMessage('兩次輸入的密碼不一致，請再確認。', true);
    submit.disabled = true;
    submit.textContent = '正在儲存…';
    try {
      await global.CloudEvents.updatePassword(password);
      global.history.replaceState({}, global.document.title, global.location.pathname + global.location.search);
      form.hidden = true;
      setMessage('密碼設定完成。現在可以前往活動管理頁登入。');
      panel.querySelector('#authSetupAdminLink').hidden = false;
    } catch (error) {
      setMessage(error?.message || '設定失敗，請重新開啟邀請信中的連結。', true);
      submit.disabled = false;
      submit.textContent = '儲存密碼';
    }
  });

  global.CloudEvents.getSession().then(session => {
    if (!session && !authError) setMessage('邀請連結可能已過期或已使用。請重新寄送邀請信後再開啟。', true);
  }).catch(error => setMessage(error?.message || '無法確認邀請連結，請稍後重試。', true));
})(window);
