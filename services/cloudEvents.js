(function (global) {
  const config = global.APP_CONFIG || {};
  const sdk = global.supabase;
  const client = sdk && config.supabaseUrl && config.supabasePublishableKey
    ? sdk.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    })
    : null;

  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });
  const requireClient = () => {
    if (!client) throw new Error('雲端資料尚未設定');
    return client;
  };
  async function requireAdmin() {
    const db = requireClient();
    const { data: { user }, error } = await db.auth.getUser();
    if (error || !user) throw new Error('請先登入管理者帳號');
    const { data, error: roleError } = await db.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
    if (roleError || !data) throw new Error('此帳號沒有管理者權限');
    return db;
  }
  global.CloudEvents = {
    isConfigured: () => Boolean(client),
    async loadPublicEvents() {
      const { data, error } = await requireClient().from('events').select('*').eq('status', 'Approved').gte('end_date', today()).order('start_date');
      if (error) throw error;
      return data || [];
    },
    async getSession() {
      const { data, error } = await requireClient().auth.getSession();
      if (error) throw error;
      return data.session;
    },
    async signIn(email, password) {
      const { data, error } = await requireClient().auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data.user;
    },
    async updatePassword(password) {
      const { data, error } = await requireClient().auth.updateUser({ password });
      if (error) throw error;
      return data.user;
    },
    async sendPasswordReset(email) {
      const redirectTo = new URL('./', global.location.href).href;
      const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await requireClient().auth.signOut();
      if (error) throw error;
    },
    async isAdmin() {
      try { await requireAdmin(); return true; } catch { return false; }
    },
    async loadAdminEvents() {
      const db = await requireAdmin();
      const { data, error } = await db.from('events').select('*').order('start_date');
      if (error) throw error;
      return data || [];
    },
    async setStatus(id, status) {
      const db = await requireAdmin();
      const { data, error } = await db.from('events').update({ status, moderated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },
    subscribePublicUpdates(callback) {
      return requireClient().channel('public-event-updates')
        .on('postgres_changes', { event:'*', schema:'public', table:'events' }, payload => callback(payload))
        .subscribe();
    }
  };
})(window);
