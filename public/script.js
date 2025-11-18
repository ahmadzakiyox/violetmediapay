document.addEventListener('DOMContentLoaded', () => {

    const socket = io();
    const logContainer = document.getElementById('heroku-logs');
    
    // UI Elements
    const ui = {
        dbText: document.getElementById('db-status-text'),
        dbDot: document.getElementById('db-indicator'),
        wsText: document.getElementById('ws-status-text'),
        wsDot: document.getElementById('ws-indicator'),
        uptime: document.getElementById('server-uptime'),
        users: document.getElementById('total-users'),
        products: document.getElementById('total-products'),
        totalTrx: document.getElementById('total-transactions'),
        successTrx: document.getElementById('success-transactions'),
        pendingTrx: document.getElementById('pending-transactions'),
        failedTrx: document.getElementById('failed-transactions')
    };

    // --- STATS LOGIC ---
    async function fetchStats() {
        try {
            const response = await fetch('/api/stats');
            const stats = await response.json();
            updateDashboard(stats);
        } catch (error) {
            console.error("Stats Error:", error);
            ui.dbText.textContent = "Error";
            ui.dbDot.className = "dot";
        }
    }

    function updateDashboard(stats) {
        // DB Status
        if (stats.dbStatus === 'CONNECTED') {
            ui.dbText.textContent = 'Online';
            ui.dbText.style.color = 'var(--accent-green)';
            ui.dbDot.className = 'dot active';
        } else {
            ui.dbText.textContent = stats.dbStatus;
            ui.dbText.style.color = 'var(--accent-red)';
            ui.dbDot.className = 'dot';
        }

        // Metrics
        ui.uptime.textContent = stats.serverUptime;
        ui.users.textContent = stats.totalUsers;
        ui.products.textContent = stats.totalProducts;
        ui.totalTrx.textContent = stats.totalTransactions;
        ui.successTrx.textContent = stats.successTransactions;
        ui.pendingTrx.textContent = stats.pendingTransactions;
        ui.failedTrx.textContent = stats.failedTransactions;
    }

    // --- LOGS LOGIC ---
    function appendLog(log) {
        if (!logContainer) return;

        const shouldScroll = logContainer.scrollTop + logContainer.clientHeight >= logContainer.scrollHeight - 50;
        const span = document.createElement('span');
        
        // Add timestamp (optional, local browser time)
        const time = new Date().toLocaleTimeString('id-ID', {hour12:false});
        span.className = `log-line source-${log.source}`;
        span.innerHTML = `<span style="opacity:0.4; font-size:0.75em; margin-right:10px">[${time}]</span>${log.line}`;

        logContainer.appendChild(span);

        // Limit logs to prevent browser lag (max 200 lines)
        if (logContainer.childElementCount > 200) {
            logContainer.removeChild(logContainer.firstChild);
        }

        if (shouldScroll) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    // --- SOCKET EVENTS ---
    socket.on('connect', () => {
        ui.wsText.textContent = "Connected";
        ui.wsText.style.color = "var(--accent-green)";
        ui.wsDot.className = "dot active";
    });

    socket.on('disconnect', () => {
        ui.wsText.textContent = "Disconnected";
        ui.wsText.style.color = "var(--accent-red)";
        ui.wsDot.className = "dot";
        appendLog({line: "⚠ Koneksi ke Server Terputus...", source: "error"});
    });

    socket.on('log', (log) => {
        appendLog(log);
    });

    // Init
    fetchStats();
    setInterval(fetchStats, 5000);
});
