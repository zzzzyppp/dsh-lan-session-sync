window.__ModuleLoader__.load({
  id: 'dsh-lan-session-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-lan-session-sync';

    const en = {
      title: 'LAN session sync',
      description:
        'Sync sessions with other DeepSeek Harness instances on your LAN. Every device is an equal peer: this device imports sessions it is missing and sends sessions a peer is missing, so a session can travel through any chain of devices. Merges by verified content and never overwrites an existing log. Set a shared key before using this on a network you do not fully trust.',
      device: 'This device',
      deviceName: 'Device name',
      deviceId: 'Device id',
      save: 'Save',
      saved: 'Saved',
      port: 'LAN port',
      discoveryPort: 'Discovery port',
      paused: 'Paused',
      pauseHint: 'Pausing stops automatic checks. Manual sync is disabled while paused.',
      auto: 'Automatic sync',
      autoHint: 'Checks LAN peers in the background, imports missing sessions and sends missing ones.',
      push: 'Send my sessions too',
      pushHint: 'Push sessions this device has and a peer is missing. Needed when the other device cannot reach this one directly.',
      interval: 'Check every',
      seconds: 'seconds',
      minutes: 'min',
      importedCount: 'imported',
      pushedCount: 'sent',
      syncNow: 'Sync now',
      syncing: 'Syncing…',
      lastSync: 'Last sync',
      never: 'Not yet',
      peers: 'Peers',
      noPeers: 'No peers found yet. Both devices need this plugin and the same LAN.',
      manualPeer: 'Manual',
      addPeer: 'Add peer',
      address: 'Address',
      remove: 'Remove',
      security: 'Shared key (optional)',
      securityHint: 'When set, peers must present the same key before they can read or import sessions. The key is stored as a credential, not in this settings file.',
      keyOn: 'Protected with a shared key',
      keyOff: 'No shared key',
      generate: 'Generate key',
      clear: 'Remove key',
      setKey: 'Use this key',
      keyPlaceholder: 'Paste a key of 16–128 characters',
      activity: 'Recent imports',
      noActivity: 'Nothing imported yet.',
      close: 'Close',
      refresh: 'Refresh',
      error: 'Something went wrong',
      importedFrom: 'from',
      aliased: 'same content',
      importedAt: 'imported',
      loading: 'Loading…',
      listenerStopped: 'listener stopped',
      keyWarning:
        'No shared key is set: anyone on this LAN can list and import your sessions, and LAN traffic is not encrypted.',
      keyRevealed: 'New key — copy it to the other device now; it is shown only once.',
      checkedPeers: 'peers checked',
      skipped: 'skipped',
      confirmClear: 'Remove the shared key? Peers using it will be rejected.',
      confirmGenerate: 'Replace the current shared key? The other device will stop syncing until you set the new key there.',
      scope: 'Sync scope',
      scopeHint: 'Files are merged with the same rules on every device: session logs append by zstd frame prefix, workspace/profile/credentials merge structurally, other files stay conflict-safe.',
      setWorkspace: 'Workspace index',
      setStorages: 'Other storages',
      setProfile: 'Profile & plugins',
      setModules: 'Installed modules',
      setCredentials: 'Credential refs (API keys only)',
      setAttachments: 'Attachments',
      setCache: 'Cache (off by default)',
      copy: 'Copy',
    };

    const zh = {
      title: '局域网会话同步',
      description:
        '与同一局域网内的其他 DeepSeek Harness 双向同步会话。所有设备都是平级节点：本机导入缺失的会话，同时把对方缺少的会话推送过去，因此会话可以经由任一设备中转。按校验内容合并，不覆盖已有日志。若不完全信任所在网络，请先设置共享密钥。',
      device: '本机',
      deviceName: '设备名称',
      deviceId: '设备 ID',
      save: '保存',
      saved: '已保存',
      port: '局域网端口',
      discoveryPort: '发现端口',
      paused: '已暂停',
      pauseHint: '暂停后不再自动检查，手动同步也会被禁用。',
      auto: '自动同步',
      autoHint: '后台定期检查局域网设备，导入缺失的会话并把对方缺少的会话推送过去。',
      push: '同时推送本机会话',
      pushHint: '把本机已有、对方缺少的会话推送过去；当对方无法直接访问本机时需要它。',
      interval: '检查间隔',
      seconds: '秒',
      minutes: '分钟',
      importedCount: '个导入',
      pushedCount: '个发出',
      syncNow: '立即同步',
      syncing: '同步中…',
      lastSync: '上次同步',
      never: '尚未同步',
      peers: '局域网设备',
      noPeers: '还没有发现设备。两台设备都需要安装本插件并连接到同一局域网。',
      manualPeer: '手动添加',
      addPeer: '添加设备',
      address: '地址',
      remove: '移除',
      security: '共享密钥（可选）',
      securityHint: '设置后，对方必须提供相同密钥才能读取或导入会话。密钥保存在凭据存储中，不写入设置文件。',
      keyOn: '已启用共享密钥',
      keyOff: '未设置共享密钥',
      generate: '生成密钥',
      clear: '移除密钥',
      setKey: '使用该密钥',
      keyPlaceholder: '粘贴 16–128 个字符的密钥',
      activity: '最近导入',
      noActivity: '还没有导入任何会话。',
      close: '关闭',
      refresh: '刷新',
      error: '出错了',
      importedFrom: '来自',
      aliased: '内容相同',
      importedAt: '导入于',
      loading: '加载中…',
      listenerStopped: '监听未启动',
      keyWarning: '未设置共享密钥：同一局域网内的任何人都可以列出并导入你的会话，且局域网流量未加密。',
      keyRevealed: '新密钥——请立即复制到另一台设备，之后不再显示。',
      checkedPeers: '个设备已检查',
      skipped: '跳过',
      confirmClear: '移除共享密钥？仍在使用该密钥的设备将被拒绝。',
      confirmGenerate: '替换当前共享密钥？另一台设备在设置新密钥前将无法同步。',
      scope: '同步范围',
      scopeHint: '每台设备用同一套规则合并文件：会话日志按 zstd 帧前缀追加，工作区/配置/凭据结构化合并，其它文件冲突时保留双方副本。',
      setWorkspace: '工作区索引',
      setStorages: '其它 storages 数据',
      setProfile: '配置与插件',
      setModules: '已安装模块',
      setCredentials: '凭据引用（仅 API_KEY）',
      setAttachments: '附件',
      setCache: '缓存（默认关闭）',
      copy: '复制',
    };

    const dictionaries = { en, zh };

    function localeText(ctx) {
      let bound = null;
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          const register = () => ctx.locale.register(NS, dictionaries);
          try {
            if (typeof ctx.effect === 'function') ctx.effect(register);
            else register();
          } catch {
            // A reload of the same bundle may already hold this namespace.
          }
          bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null;
        }
      } catch {
        bound = null;
      }
      return (key) => {
        try {
          if (bound) return bound(key);
        } catch {
          // Fall back to the English dictionary.
        }
        return en[key] ?? key;
      };
    }

    async function api(pathname, options = {}) {
      const response = await fetch(`/lan-session-sync/api${pathname}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`);
        error.payload = payload;
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function formatTime(t, value, localeTag) {
      if (!value) return t('never');
      try {
        return new Date(value).toLocaleString(localeTag || undefined);
      } catch {
        return String(value);
      }
    }

    function formatInterval(t, ms) {
      const seconds = Math.round(Number(ms) / 1000);
      if (!Number.isFinite(seconds) || seconds <= 0) return String(ms);
      if (seconds % 60 === 0) return `${seconds / 60} ${t('minutes')}`;
      return `${seconds} ${t('seconds')}`;
    }

    const styles = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '20px 22px 28px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        minHeight: '100%',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.3 },
      subtitle: { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' },
      rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      small: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      scopeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '6px 14px' },
      input: {
        flex: '1 1 180px',
        minWidth: '140px',
        boxSizing: 'border-box',
        padding: '6px 9px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
      },
      select: {
        padding: '6px 9px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
      },
      button: {
        padding: '6px 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        cursor: 'pointer',
      },
      primaryButton: {
        padding: '6px 14px',
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: '7px',
        cursor: 'pointer',
      },
      dangerButton: {
        padding: '4px 9px',
        fontSize: '12px',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '8px 10px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        fontSize: '13px',
      },
      badge: {
        padding: '1px 7px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '999px',
      },
      error: {
        padding: '8px 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-state-error-secondary)',
        borderRadius: '8px',
      },
      success: {
        padding: '6px 10px',
        fontSize: '12px',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
    };

    function Panel(rawProps) {
      const props = rawProps ?? {};
      const translate = props.__t ?? ((key) => en[key] ?? key);
      const localeTag = props.__locale;
      const [status, setStatus] = React.useState(null);
      const [config, setConfig] = React.useState(null);
      const [activity, setActivity] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [loaded, setLoaded] = React.useState(false);
      const [flash, setFlash] = React.useState(null);
      const [draftName, setDraftName] = React.useState('');
      const [peerAddress, setPeerAddress] = React.useState('');
      const [peerPort, setPeerPort] = React.useState('47830');
      const [keyValue, setKeyValue] = React.useState('');
      const [revealedKey, setRevealedKey] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const [nextStatus, nextConfig] = await Promise.all([api('/status'), api('/config')]);
          setStatus(nextStatus);
          setConfig(nextConfig);
          setDraftName((current) => current || nextConfig.deviceName || '');
          setLoaded(true);
        } catch (failure) {
          setError(failure.message);
        }
      }, []);

      const refreshActivity = React.useCallback(async () => {
        try {
          setActivity(await api('/activity'));
        } catch {
          // Activity is informational only.
        }
      }, []);

      React.useEffect(() => {
        void refresh();
        void refreshActivity();
        const timer = setInterval(() => {
          void refresh();
        }, 4000);
        const activityTimer = setInterval(() => {
          void refreshActivity();
        }, 15000);
        return () => {
          clearInterval(timer);
          clearInterval(activityTimer);
        };
      }, [refresh, refreshActivity]);

      const flashTimer = React.useRef(null);

      React.useEffect(
        () => () => {
          if (flashTimer.current) clearTimeout(flashTimer.current);
        },
        [],
      );

      const showFlash = (text) => {
        setFlash(text);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => {
          flashTimer.current = null;
          setFlash(null);
        }, 2000);
      };

      const run = async (operation) => {
        setBusy(true);
        setError(null);
        try {
          await operation();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      };

      const saveName = () =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { deviceName: draftName } });
          setConfig(result);
          showFlash(translate('saved'));
        });

      const togglePaused = (next) =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { paused: next } });
          setConfig(result);
        });

      const toggleAuto = (next) =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { auto: next } });
          setConfig(result);
        });

      const togglePush = (next) =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { push: next } });
          setConfig(result);
        });

      const toggleSet = (id, next) =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { sets: { [id]: next } } });
          setConfig(result);
        });

      const changeInterval = (event) =>
        run(async () => {
          const result = await api('/config', { method: 'POST', body: { autoSyncMs: Number(event.target.value) } });
          setConfig(result);
        });

      const syncNow = () =>
        run(async () => {
          const result = await api('/sync', { method: 'POST' });
          if (result?.busy) {
            showFlash(translate('syncing'));
            return;
          }
          await refresh();
          await refreshActivity();
        });

      const addPeer = () =>
        run(async () => {
          const result = await api('/peer', {
            method: 'POST',
            body: { action: 'add', address: peerAddress.trim(), port: Number(peerPort) },
          });
          setConfig(result);
          setPeerAddress('');
          showFlash(translate('saved'));
        });

      const removePeer = (peer) =>
        run(async () => {
          const result = await api('/peer', {
            method: 'POST',
            body: { action: 'remove', address: peer.address, port: peer.port },
          });
          setConfig(result);
        });

      const changeKey = (mode) =>
        run(async () => {
          if (mode === 'clear' && !window.confirm(translate('confirmClear'))) return;
          if (mode === 'generate' && service.keyEnabled && !window.confirm(translate('confirmGenerate'))) return;
          const body = { mode };
          if (mode === 'set') body.value = keyValue.trim();
          const result = await api('/key', { method: 'POST', body });
          setRevealedKey(typeof result?.key === 'string' ? result.key : '');
          await refresh();
          await refreshActivity();
          setKeyValue('');
          showFlash(result.keyEnabled ? translate('keyOn') : translate('keyOff'));
        });

      const service = status?.service ?? {};
      const peers = Array.isArray(status?.peers) ? status.peers : [];
      const imports = Array.isArray(activity?.imports) ? activity.imports : [];
      const last = status?.last;
      const intervalOptions = [10000, 30000, 60000, 300000];
      const currentInterval = Number(config?.autoSyncMs);
      if (Number.isFinite(currentInterval) && currentInterval > 0 && !intervalOptions.includes(currentInterval)) {
        intervalOptions.push(currentInterval);
        intervalOptions.sort((left, right) => left - right);
      }

      if (!loaded) {
        return h('div', { style: styles.panel }, h('div', { style: styles.small }, translate('loading')));
      }

      const header = h(
        'div',
        { style: styles.header },
        h(
          'div',
          null,
          h('h2', { style: styles.title }, translate('title')),
          h('p', { style: styles.subtitle }, translate('description')),
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { type: 'button', style: styles.button, onClick: refresh, disabled: busy }, translate('refresh')),
          h('button', { type: 'button', style: styles.button, onClick: () => props.close?.() }, translate('close')),
        ),
      );

      const deviceCard = h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardTitle }, translate('device')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, `${translate('deviceName')}`),
          h('input', {
            style: styles.input,
            value: draftName,
            maxLength: 64,
            'aria-label': translate('deviceName'),
            onChange: (event) => setDraftName(event.target.value),
          }),
          h('button', { type: 'button', style: styles.button, onClick: saveName, disabled: busy }, translate('save')),
          h('span', { style: styles.small, title: status?.device?.id ?? '' }, `${translate('deviceId')}: ${(status?.device?.id ?? '').slice(0, 8)}…`),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.small }, `${translate('port')}: ${service.port ?? '—'}`),
          h('span', { style: styles.small }, `${translate('discoveryPort')}: ${service.discoveryPort ?? '—'}`),
          service.running ? null : h('span', { style: styles.small }, `· ${translate('listenerStopped')}`),
          flash ? h('span', { style: styles.success, role: 'status', 'aria-live': 'polite' }, flash) : null,
        ),
        service.error ? h('div', { style: styles.error }, `${translate('error')}: ${service.error}`) : null,
        h(
          'div',
          { style: styles.rowBetween },
          h(
            'label',
            { style: styles.checkboxRow },
            h('input', { type: 'checkbox', checked: Boolean(service.paused), onChange: (event) => togglePaused(event.target.checked) }),
            h('span', null, translate('paused')),
          ),
          h('span', { style: styles.small }, translate('pauseHint')),
        ),
      );

      const syncCard = h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.rowBetween },
          h(
            'label',
            { style: styles.checkboxRow },
            h('input', { type: 'checkbox', checked: Boolean(config?.auto), onChange: (event) => toggleAuto(event.target.checked) }),
            h('span', null, translate('auto')),
          ),
          h('button', { type: 'button', style: styles.primaryButton, onClick: syncNow, disabled: busy || service.paused === true }, translate('syncNow')),
        ),
        h('div', { style: styles.small }, translate('autoHint')),
        h(
          'div',
          { style: styles.rowBetween },
          h(
            'label',
            { style: styles.checkboxRow },
            h('input', { type: 'checkbox', checked: config?.push !== false, onChange: (event) => togglePush(event.target.checked) }),
            h('span', null, translate('push')),
          ),
        ),
        h('div', { style: styles.small }, translate('pushHint')),
        h('div', { style: { ...styles.label, marginTop: '12px' } }, translate('scope')),
        h(
          'div',
          { style: styles.scopeGrid },
          ['workspace', 'storages', 'profile', 'modules', 'credentials', 'attachments', 'cache'].map((id) =>
            h(
              'label',
              { key: id, style: styles.checkboxRow },
              h('input', {
                type: 'checkbox',
                checked: config?.sets?.[id] !== false,
                onChange: (event) => toggleSet(id, event.target.checked),
                disabled: busy,
              }),
              h('span', { style: styles.small }, translate(`set${id[0].toUpperCase()}${id.slice(1)}`)),
            ),
          ),
        ),
        h('div', { style: styles.small }, translate('scopeHint')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, translate('interval')),
          h(
            'select',
            { style: styles.select, value: String(config?.autoSyncMs ?? 30000), 'aria-label': translate('interval'), onChange: changeInterval, disabled: busy },
            intervalOptions.map((value) =>
              h('option', { key: value, value: String(value) }, formatInterval(translate, value)),
            ),
          ),
          h(
            'span',
            { style: styles.small },
            `${translate('lastSync')}: ${
              last
                ? `${formatTime(translate, last.finishedAt, localeTag)} · ${last.peers} ${translate('checkedPeers')} · ${last.imported} ${translate('importedCount')} · ${last.pushed ?? 0} ${translate('pushedCount')} · ${translate('skipped')} ${last.skipped}`
                : translate('never')
            }`,
          ),
        ),
        last && last.errors && last.errors.length > 0
          ? h(
              'div',
              { style: styles.small },
              last.errors
                .map((entry) => `${entry.stage ?? 'sync'}: ${entry.message ?? entry.code ?? 'error'}`)
                .join(' · '),
            )
          : null,
      );

      const peersCard = h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardTitle }, translate('peers')),
        peers.length === 0
          ? h('div', { style: styles.small }, translate('noPeers'))
          : h(
              'div',
              { style: styles.list },
              peers.map((peer) =>
                h(
                  'div',
                  { key: `${peer.deviceId ?? 'manual'}:${peer.address}:${peer.port}`, style: styles.listRow },
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('div', { style: { overflowWrap: 'anywhere' } }, peer.name || peer.address),
                    h(
                      'div',
                      { style: { ...styles.small, overflowWrap: 'anywhere' } },
                      `${peer.address}:${peer.port}${peer.deviceId ? ` · ${peer.deviceId.slice(0, 8)}…` : ''}`,
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.row },
                    peer.manual ? h('span', { style: styles.badge }, translate('manualPeer')) : null,
                    peer.manual
                      ? h('button', { type: 'button', style: styles.dangerButton, onClick: () => removePeer(peer), disabled: busy }, translate('remove'))
                      : null,
                  ),
                ),
              ),
            ),
        h(
          'div',
          { style: styles.row },
          h('input', {
            style: styles.input,
            placeholder: translate('address'),
            'aria-label': translate('address'),
            value: peerAddress,
            onChange: (event) => setPeerAddress(event.target.value),
          }),
          h('input', {
            style: { ...styles.input, flex: '0 1 100px' },
            inputMode: 'numeric',
            placeholder: '47830',
            'aria-label': translate('port'),
            value: peerPort,
            onChange: (event) => setPeerPort(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              style: styles.button,
              onClick: addPeer,
              disabled:
                busy
                || peerAddress.trim().length === 0
                || !Number.isInteger(Number(peerPort))
                || Number(peerPort) < 1
                || Number(peerPort) > 65535,
            },
            translate('addPeer'),
          ),
        ),
      );

      const securityCard = h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardTitle }, translate('security')),
        h('div', { style: styles.rowBetween }, h('span', { style: styles.small }, service.keyEnabled ? translate('keyOn') : translate('keyOff'))),
        h('div', { style: styles.small }, translate('securityHint')),
        service.keyEnabled ? null : h('div', { style: styles.error }, translate('keyWarning')),
        revealedKey
          ? h(
              'div',
              { style: styles.row },
              h('input', {
                style: styles.input,
                readOnly: true,
                value: revealedKey,
                'aria-label': translate('keyRevealed'),
                onFocus: (event) => event.target.select(),
              }),
              h('span', { style: styles.small }, translate('keyRevealed')),
            )
          : null,
        h(
          'div',
          { style: styles.row },
          h('button', { type: 'button', style: styles.button, onClick: () => changeKey('generate'), disabled: busy }, translate('generate')),
          h(
            'button',
            { type: 'button', style: styles.dangerButton, onClick: () => changeKey('clear'), disabled: busy || !service.keyEnabled },
            translate('clear'),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h('input', {
            style: styles.input,
            type: 'password',
            placeholder: translate('keyPlaceholder'),
            'aria-label': translate('security'),
            value: keyValue,
            onChange: (event) => setKeyValue(event.target.value),
          }),
          h('button', { type: 'button', style: styles.button, onClick: () => changeKey('set'), disabled: busy }, translate('setKey')),
        ),
      );

      const activityCard = h(
        'div',
        { style: styles.card },
        h('div', { style: styles.cardTitle }, translate('activity')),
        imports.length === 0
          ? h('div', { style: styles.small }, translate('noActivity'))
          : h(
              'div',
              { style: styles.list },
              imports.map((entry) =>
                h(
                  'div',
                  { key: `${entry.origin}:${entry.importedAt}`, style: styles.listRow },
                  h(
                    'div',
                    null,
                    h('div', null, entry.localId ? `${entry.localId.slice(0, 24)}…` : entry.origin),
                    h(
                      'div',
                      { style: styles.small },
                      `${translate('importedFrom')} ${entry.deviceId ?? '?'} · ${formatTime(translate, entry.importedAt, localeTag)}${entry.alias ? ` · ${translate('aliased')}` : ''}`,
                    ),
                  ),
                ),
              ),
            ),
      );

      return h(
        'div',
        { style: styles.panel },
        header,
        error ? h('div', { style: styles.error, role: 'alert', 'aria-live': 'assertive' }, `${translate('error')}: ${error}`) : null,
        deviceCard,
        syncCard,
        peersCard,
        securityCard,
        activityCard,
      );
    }

    function createPanel(ctx) {
      const translate = localeText(ctx);
      let localeTag;
      try {
        localeTag = ctx.locale?.getLocale?.()?.active;
      } catch {
        localeTag = undefined;
      }
      function BoundPanel(props) {
        return h(Panel, { ...props, __t: translate, __locale: localeTag });
      }
      BoundPanel.displayName = 'LanSessionSyncPanel';
      return { BoundPanel, translate };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const { BoundPanel, translate } = createPanel(ctx);
        try {
          ctx.slots.inject('settings.section', () => {
            const unregister = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'lan-session-sync',
                order: 24,
                label: () => translate('title'),
                locale: NS,
              },
              BoundPanel,
            );
            return () => unregister();
          });
        } catch (error) {
          console.warn('lan-session-sync: could not register settings section', error);
        }
      },
    };
  },
});
