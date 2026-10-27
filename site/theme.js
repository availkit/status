// A non-sensitive explicit preference only. First visit follows AvailKit's dark default.
try { const theme = localStorage.getItem('availkit-theme'); if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme; } catch { /* storage optional */ }
