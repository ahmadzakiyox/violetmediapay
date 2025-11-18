:root {
    --bg-body: #0f172a;
    --bg-sidebar: #1e293b;
    --bg-card: #1e293b;
    --bg-terminal: #000000;
    --text-main: #f8fafc;
    --text-muted: #94a3b8;
    
    --accent-purple: #8b5cf6;
    --accent-blue: #3b82f6;
    --accent-green: #10b981;
    --accent-orange: #f59e0b;
    --accent-red: #ef4444;
    
    --border-color: rgba(255,255,255,0.1);
    --font-main: 'Outfit', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    background-color: var(--bg-body);
    color: var(--text-main);
    font-family: var(--font-main);
    height: 100vh;
    overflow: hidden; 
}

.app-container { display: flex; height: 100%; }

/* SIDEBAR */
.sidebar {
    width: 260px;
    background-color: var(--bg-sidebar);
    border-right: 1px solid var(--border-color);
    padding: 25px;
    display: flex; flex-direction: column; gap: 20px;
}

.brand {
    display: flex; align-items: center; gap: 15px;
    padding-bottom: 20px; border-bottom: 1px solid var(--border-color);
}
.logo-icon { font-size: 2rem; color: var(--accent-blue); }
.brand h1 { font-size: 1.2rem; font-weight: 700; letter-spacing: 1px; }
.brand span { font-size: 0.8rem; color: var(--text-muted); }

.menu-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 600; margin-top: 10px; }

.nav-item {
    width: 100%; background: transparent; border: none; color: var(--text-muted);
    padding: 12px; text-align: left; cursor: pointer; font-size: 0.95rem;
    display: flex; align-items: center; gap: 10px; border-radius: 8px; transition: 0.3s;
}
.nav-item:hover, .nav-item.active { background: rgba(59, 130, 246, 0.1); color: var(--accent-blue); }

.status-card { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 12px; border: 1px solid var(--border-color); }
.status-item { display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 10px; }
.status-item:last-child { margin-bottom: 0; }
.mono-text { font-family: var(--font-mono); color: var(--accent-blue); }

/* MAIN */
.main-content { flex: 1; padding: 30px; overflow-y: auto; display: flex; flex-direction: column; }

/* STATS */
.stats-overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 25px; }
.stat-card {
    background: var(--bg-card); padding: 20px; border-radius: 16px;
    display: flex; align-items: center; gap: 15px; border: 1px solid var(--border-color);
}
.icon-box { width: 50px; height: 50px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }
.stat-card.purple .icon-box { background: rgba(139, 92, 246, 0.2); color: var(--accent-purple); }
.stat-card.blue .icon-box { background: rgba(59, 130, 246, 0.2); color: var(--accent-blue); }
.stat-card.green .icon-box { background: rgba(16, 185, 129, 0.2); color: var(--accent-green); }
.stat-card.orange .icon-box { background: rgba(245, 158, 11, 0.2); color: var(--accent-orange); }
.stat-card span { font-size: 0.85rem; color: var(--text-muted); }
.stat-card h2 { font-size: 1.8rem; font-family: var(--font-mono); }

/* PANELS */
.panel { background: var(--bg-card); border-radius: 16px; border: 1px solid var(--border-color); overflow: hidden; }
.panel-header { padding: 20px; border-bottom: 1px solid var(--border-color); }
.flex-between { display: flex; justify-content: space-between; align-items: center; }

/* TABLES */
.table-responsive { width: 100%; overflow-x: auto; }
.cyber-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.cyber-table th { text-align: left; padding: 15px; color: var(--text-muted); border-bottom: 1px solid var(--border-color); }
.cyber-table td { padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-main); }
.cyber-table tr:hover { background: rgba(255,255,255,0.02); }

/* BUTTONS */
.btn-primary, .btn-secondary, .btn-success, .btn-danger, .btn-icon {
    padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; transition: 0.2s; font-family: inherit;
}
.btn-primary { background: var(--accent-blue); color: white; }
.btn-success { background: var(--accent-green); color: white; }
.btn-danger { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }
.btn-secondary { background: transparent; border: 1px solid var(--border-color); color: var(--text-muted); }
.btn-icon { padding: 6px; font-size: 1.1rem; }

/* TERMINAL */
.terminal-panel { background: #000; display: flex; flex-direction: column; height: 400px; }
.terminal-header { background: #1a1a1a; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #333; }
.terminal-title { color: #666; font-family: var(--font-mono); font-size: 0.8rem; display: flex; align-items: center; gap: 8px; }
.live-badge { background: rgba(16, 185, 129, 0.2); color: var(--accent-green); padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; }
.terminal-body { flex: 1; padding: 15px; overflow-y: auto; background: #0c0c0c; }
.log-content { font-family: 'Consolas', monospace; font-size: 0.85rem; color: #d4d4d4; white-space: pre-wrap; line-height: 1.5; }
.log-line.source-server { color: var(--accent-green); }
.log-line.source-error { color: var(--accent-red); }
.log-line.source-router { color: var(--accent-blue); }

/* MODALS */
.modal-overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); backdrop-filter: blur(5px);
    display: none; align-items: center; justify-content: center; z-index: 1000;
}
.modal-box {
    background: var(--bg-card); width: 500px; max-width: 90%;
    border-radius: 12px; padding: 25px; border: 1px solid var(--border-color);
    box-shadow: 0 20px 50px rgba(0,0,0,0.5);
}
.modal-header { display: flex; justify-content: space-between; margin-bottom: 20px; }
.close-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.2rem; }
.form-group { margin-bottom: 15px; }
.form-group label { display: block; margin-bottom: 8px; color: var(--text-muted); font-size: 0.9rem; }
.form-group input, .form-group textarea {
    width: 100%; background: rgba(0,0,0,0.2); border: 1px solid var(--border-color);
    color: white; padding: 10px; border-radius: 6px; font-family: inherit;
}
.form-group input:focus { border-color: var(--accent-blue); outline: none; }
.code-input { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
.modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.text-accent { color: var(--accent-blue); font-weight: bold; }
