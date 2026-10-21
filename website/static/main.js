// Display chart times in the browser's local time.
window.formatTime = function(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    function pad(number) { return String(number).padStart(2, '0'); }
    var hour = date.getHours();
    return (hour % 12 || 12) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
        (hour < 12 ? ' AM' : ' PM');
};

// Display dates in the browser's local time using the shared site format.
window.formatDateTime = function(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    function pad(number) { return String(number).padStart(2, '0'); }
    var hour = date.getHours();
    return date.getFullYear() + '.' + pad(date.getMonth() + 1) + '.' + pad(date.getDate()) +
        ', ' + (hour % 12 || 12) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
        (hour < 12 ? ' AM' : ' PM');
};

$(function(){

    window.statsSource = new EventSource("/api/live_stats");
    window.statsSource.addEventListener('message', function(event) {
        var stats = JSON.parse(event.data);
        $('tr[data-pool]').each(function() {
            var pool = stats.pools[$(this).attr('data-pool')];
            if (!pool) return;
            $(this).find('[data-stat="workers"]').text(pool.workerCount);
            $(this).find('[data-stat="validShares"]').text(pool.poolStats.validShares);
            $(this).find('[data-stat="invalidShares"]').text(pool.poolStats.invalidShares);
            $(this).find('[data-stat="hashrate"]').text(pool.hashrateString);
        });
    });

});
