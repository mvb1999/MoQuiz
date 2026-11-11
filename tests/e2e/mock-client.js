// Injected into every test page before the app loads. Replaces window.supabase
// with a fake client whose calls are routed to the Node-side mock backend.
(() => {
  const channels = new Set();
  const call = (name, args) => window.__mockRpc(name, args || {});

  window.__mockNotify = (table, roomId) => {
    for (const ch of channels) {
      for (const h of ch.handlers) {
        if (h.type !== 'postgres_changes') continue;
        if (h.filter.table !== table) continue;
        if (h.filter.filter && !h.filter.filter.endsWith('.' + roomId)) continue;
        try { h.cb({}); } catch (e) { console.error(e); }
      }
    }
  };
  window.__mockBroadcast = (topic, event, payload) => {
    for (const ch of channels) {
      if (ch.topic !== topic) continue;
      for (const h of ch.handlers) {
        if (h.type !== 'broadcast') continue;
        if (h.filter.event !== '*' && h.filter.event !== event) continue;
        try { h.cb({ type: 'broadcast', event, payload }); } catch (e) { console.error(e); }
      }
    }
  };
  window.__mockKill = () => {
    for (const ch of channels) ch.statusCb && ch.statusCb('CHANNEL_ERROR');
  };

  function query(table) {
    const q = { table, filters: {}, single: false };
    const api = {
      select() { return api; },
      eq(col, val) { q.filters[col] = val; return api; },
      order() { return api; },
      single() { q.single = true; return api; },
      then(res, rej) { return call('select:' + table, q).then(res, rej); },
    };
    return api;
  }

  const client = {
    rpc: (name, args) => call(name, args),
    from: query,
    channel(topic) {
      const ch = {
        topic, handlers: [], statusCb: null,
        on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return ch; },
        subscribe(cb) { ch.statusCb = cb; channels.add(ch); setTimeout(() => cb && cb('SUBSCRIBED'), 20); return ch; },
        send(msg) { return window.__mockSend(topic, msg.event, msg.payload).then(() => 'ok'); },
      };
      return ch;
    },
    removeChannel(ch) { channels.delete(ch); ch.statusCb && ch.statusCb('CLOSED'); return Promise.resolve('ok'); },
    auth: {
      async getSession() { const u = window.__mockUser; return { data: { session: u ? { user: u } : null } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async setSession() { return { data: { user: window.__mockUser }, error: null }; },
      async signInWithPassword({ email, password }) {
        window.__authCalls = (window.__authCalls || []).concat([['signIn', email]]);
        if (password !== 'geheim123') return { data: {}, error: { message: 'Invalid login credentials' } };
        window.__mockUser = { id: 'u9', email, user_metadata: { username: 'Neuer User' } }; return { data: { user: window.__mockUser, session: {} }, error: null };
      },
      async signUp({ email }) { window.__authCalls = (window.__authCalls || []).concat([['signUp', email]]); return { data: { user: { id: 'u9' }, session: {} }, error: null }; },
      async signOut() { window.__mockUser = null; return { error: null }; },
    },
    storage: { from() { return { async upload() { return { error: null }; }, getPublicUrl(p) { return { data: { publicUrl: 'https://example.com/' + p } }; } }; } },
  };
  window.supabase = { createClient: () => client };
})();
