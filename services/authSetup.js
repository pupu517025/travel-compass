(function (global) {
  const query = new URLSearchParams(global.location.search);
  const hash = new URLSearchParams(global.location.hash.replace(/^#/, ''));
  const flow = query.get('type') || hash.get('type');
  const authError = query.get('error_description') || hash.get('error_description');
  const needsPasswordSetup = ['invite', 'recovery'].includes(flow)
    || query.has('code') || hash.has('access_token') || Boolean(authError);
  if (!global.CloudEvents?.isConfigured()) return;
  let panel;
  let sessionReady = false;

  function setMessage(text, error = false) {
    if (!panel) return;
    const message = panel.querySelector('#authSetupMessage');
    message.textContent = text;
    message.style.color = error ? '#a14832' : '#52665d';
  }

  function showPasswordForm() {
    if (panel) return;
    panel = document.createElement('section');
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
    global.document.body.append(panel);

    const form = panel.querySelector('#authSetupForm');
    const submit = panel.querySelector('#authSetupSubmit');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!sessionReady) return setMessage('登入連結尚未確認，請稍候再試。', true);
      const password = panel.querySelector('#authSetupPassword').value;
      const confirm = panel.querySelector('#authSetupConfirm').value;
      if (password !== confirm) return setMessage('兩次輸入的密碼不一致，請再確認。', true);
      submit.disabled = true;
      submit.textContent = '正在儲存…';
      try {
        await global.CloudEvents.updatePassword(password);
        global.history.replaceState({}, global.document.title, global.location.pathname);
        form.hidden = true;
        setMessage('密碼設定完成。現在可以前往活動管理頁登入。');
        panel.querySelector('#authSetupAdminLink').hidden = false;
      } catch (error) {
        setMessage(error?.message || '設定失敗，請重新寄送密碼連結後再試。', true);
        submit.disabled = false;
        submit.textContent = '儲存密碼';
      }
    });
    if (authError) setMessage(`連結無法使用：${authError.replaceAll('+', ' ')}`, true);
    else setMessage('正在確認連結…');
  }

  function setSessionReady(session) {
    sessionReady = Boolean(session);
    if (sessionReady) setMessage('請設定並確認新密碼。');
    else if (panel && !authError) setMessage('連結可能已過期或已使用。請從管理頁重新寄送密碼連結。', true);
  }

  if (needsPasswordSetup) {
    showPasswordForm();
    global.CloudEvents.getSession().then(setSessionReady)
      .catch(error => setMessage(error?.message || '無法確認連結，請稍後重試。', true));
  }

  global.CloudEvents.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && ['invite', 'recovery'].includes(flow))) {
      showPasswordForm();
      setSessionReady(session);
    }
  });
})(window);
