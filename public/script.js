document.addEventListener('DOMContentLoaded', () => {

    // Inisialisasi Socket.IO
    const socket = io();
    const logContainer = document.getElementById('heroku-logs');

    // Ambil semua elemen statistik
    const elements = {
        dbStatusBox: document.getElementById('db-status-box'),
        dbStatusIcon: document.getElementById('db-status-icon'),
        dbStatusText: document.getElementById('db-status-text'),
        serverUptime: document.getElementById('server-uptime'),
        totalUsers: document.getElementById('total-users'),
        totalProducts: document.getElementById('total-products'),
        totalTransactions: document.getElementById('total-transactions'),
        successTransactions: document.getElementById('success-transactions'),
        pendingTransactions: document.getElementById('pending-transactions'),
        failedTransactions: document.getElementById('failed-transactions')
    };

    /**
     * Fungsi untuk mengambil data statistik dari API
     */
    async function fetchStats() {
        try {
            const response = await fetch('/api/stats');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const stats = await response.json();
            updateDashboard(stats);
        } catch (error) {
            console.error("Gagal mengambil statistik:", error);
            elements.serverUptime.textContent = "Error";
        }
    }

    /**
     * Fungsi untuk mengupdate DOM dengan data statistik baru
     */
    function updateDashboard(stats) {
        // Update Status DB
        const dbStatus = stats.dbStatus || 'DISCONNECTED';
        elements.dbStatusText.textContent = dbStatus;
        
        elements.dbStatusBox.classList.remove('connected', 'disconnected', 'connecting');

        if (dbStatus === 'CONNECTED') {
            elements.dbStatusBox.classList.add('connected');
            elements.dbStatusIcon.textContent = '✓';
        } else if (dbStatus === 'CONNECTING') {
            elements.dbStatusBox.classList.add('connecting');
            elements.dbStatusIcon.textContent = '...';
        } else {
            elements.dbStatusBox.classList.add('disconnected');
            elements.dbStatusIcon.textContent = 'X';
        }

        // Update Teks Statistik Lainnya
        elements.serverUptime.textContent = stats.serverUptime || '0h 0m 0s';
        elements.totalUsers.textContent = stats.totalUsers ?? '0';
        elements.totalProducts.textContent = stats.totalProducts ?? '0';
        elements.totalTransactions.textContent = stats.totalTransactions ?? '0';
        elements.successTransactions.textContent = stats.successTransactions ?? '0';
        elements.pendingTransactions.textContent = stats.pendingTransactions ?? '0';
        elements.failedTransactions.textContent = stats.failedTransactions ?? '0';
    }

    // Ambil data statistik saat halaman dimuat
    fetchStats();

    // Set interval untuk refresh data statistik setiap 5 detik
    setInterval(fetchStats, 5000); 

    // ===========================================
    // ========= LOGIKA STREAMING LOG ============
    // ===========================================

    /**
     * Fungsi untuk menambahkan baris log baru ke dashboard
     * @param {object} log - Objek log { line, source }
     */
    function appendLog(log) {
        if (!logContainer) return;

        const shouldScroll = logContainer.scrollTop + logContainer.clientHeight >= logContainer.scrollHeight - 30;

        const logLine = document.createElement('span');
        logLine.className = `log-line source-${log.source}`;
        logLine.textContent = log.line;

        logContainer.appendChild(logLine);

        if (shouldScroll) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    // Terima log dari server
    socket.on('log', (log) => {
        appendLog(log);
    });

    // Tangani koneksi dan diskoneksi
    socket.on('connect', () => {
        console.log('Terhubung ke server WebSocket');
    });

    socket.on('disconnect', () => {
        console.log('Terputus dari server WebSocket');
        appendLog({ line: '=== [Log Stream] Terputus dari server. Mencoba terhubung kembali... ===\n', source: 'error' });
    });

});
